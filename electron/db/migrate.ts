/**
 * Migrations Drizzle au démarrage du processus **main** (PLAN-ELECTRON §2.2 —
 * tâche 2.5).
 *
 * Sur un cluster vierge (42+ tables absentes), aucune page ne peut être servie :
 * les migrations versionnées `drizzle/*.sql` sont donc appliquées **après** la
 * santé de PostgreSQL (`startLocalDb()`) et **avant** toute construction d'env,
 * tout lancement de serveur et toute ouverture de fenêtre (`main.ts`).
 *
 * Comportements non négociables :
 *  - **idempotent** : le migrateur Drizzle suit ses migrations appliquées dans
 *    la table `__drizzle_migrations` — une seconde exécution ne réapplique rien
 *    (base de dev réutilisée, redémarrages multiples) ;
 *  - **résolution du dossier** : packagé (`app.isPackaged === true`) →
 *    `process.resourcesPath/drizzle` (étape 9, `extraResources`) testé
 *    **en premier** ; dev → `<racine projet>/drizzle` (helper partagé
 *    `resolveDevProjectRoot()` de `electron/server/next.ts`), seulement si
 *    `!app.isPackaged` (sinon il tomberait sur `app.asar`, qui contient un
 *    `package.json`, et primerait à tort sur la copie fraîche) ; puis
 *    `app.getAppPath()/drizzle` — aucun `meta/_journal.json` trouvé → rejet
 *    listant chaque candidat testé ;
 *  - **journalisation** : `electron-log` **uniquement** (jamais `console.log`),
 *    toute URL passant par `redactSecrets()` (elle contient le mot de passe) ;
 *  - **échec fermé** : rejet explicite (aucun démarrage sur schéma partiel) dont
 *    le message porte la cause racine **redactée**. L'erreur d'origine n'est
 *    jamais réattachée en `cause` : `handleStartupFailure()` journalise l'erreur
 *    en entier et y ferait figurer une URL en clair ;
 *  - **connexion** : `postgres(url, { max: 1 })`, fermée dans le `finally` même
 *    en cas de rejet du migrateur (aucune connexion orpheline).
 *
 * Packaging (étape 9) : copier `drizzle/` (SQL + `meta/_journal.json`) via
 * `extraResources` → `<resources>/drizzle`, ou le laisser dans l'asar
 * (`app.getAppPath()` lit via le système de fichiers virtuel d'asar).
 */

import { app } from 'electron'
import log from 'electron-log'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { existsSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { redactSecrets, resolveDevProjectRoot } from '../server/next'

/** Relatif à chaque candidat : le journal prouve un dossier de migrations complet. */
const JOURNAL_RELATIVE_PATH = path.join('meta', '_journal.json')

/** Délai borné de fermeture de la connexion unique du migrateur. */
const CONNECTION_END_TIMEOUT_S = 5

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Candidats du dossier `drizzle`, dans l'ordre imposé par le plan :
 *  1. packagé (`app.isPackaged === true`) : `<process.resourcesPath>/drizzle`
 *     (étape 9, `extraResources`) — testé **en premier**, avant tout chemin
 *     dérivé de `resolveDevProjectRoot()` ;
 *  2. dev (`!app.isPackaged`) : `<racine projet>/drizzle` — même résolution que
 *     `electron/server/next.ts` (`resolveDevProjectRoot()`, helper réutilisé
 *     plutôt que dupliqué) ;
 *  3. `<app.getAppPath()>/drizzle` (contenu asar, ou dossier lancé en dev).
 *
 * En mode packagé, `resolveDevProjectRoot()` trouverait un `package.json` dans
 * `app.asar` : le candidat « dev » y deviendrait `app.asar/drizzle` et primerait
 * à tort sur la copie fraîche `extraResources` — d'où l'ordre conditionnel, le
 * chemin dérivé de la racine dev n'étant considéré que si `!app.isPackaged`.
 *
 * Doublons éliminés (la racine dev et `app.getAppPath()` convergent souvent) :
 * le message d'erreur final ne doit lister chaque chemin qu'une fois.
 */
function migrationFolderCandidates(): string[] {
  const candidates: string[] = []
  const push = (candidate: string): void => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }
  // `process.resourcesPath` n'existe que dans Electron (et vaut '' ailleurs) :
  // garde défensive plutôt que `path.join(undefined, …)`.
  const resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath
  if (app.isPackaged) {
    if (typeof resourcesPath === 'string' && resourcesPath !== '') {
      push(path.join(resourcesPath, 'drizzle'))
    }
  } else {
    push(path.join(resolveDevProjectRoot(), 'drizzle'))
  }
  push(path.join(app.getAppPath(), 'drizzle'))
  return candidates
}

/**
 * Premier candidat contenant `meta/_journal.json`.
 *
 * Sans journal, le migrateur Drizzle rejetterait sur une erreur obscure au
 * milieu du démarrage : ici, le rejet liste chaque chemin testé — le diagnostic
 * « étape 9 : copier `drizzle/` » est alors immédiat.
 */
function resolveMigrationsFolder(): string {
  const candidates = migrationFolderCandidates()
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, JOURNAL_RELATIVE_PATH))) {
      return candidate
    }
  }
  throw new Error(
    [
      `dossier de migrations Drizzle introuvable (aucun « ${JOURNAL_RELATIVE_PATH} » détecté).`,
      `Chemins recherchés :\n- ${candidates.join('\n- ')}`,
      'En production, copiez `drizzle/` via `extraResources` (étape 9 du plan).',
    ].join('\n'),
  )
}

/** Cause la plus profonde de la chaîne `error.cause` (boucle protégée). */
function rootCauseOf(error: unknown): unknown {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current instanceof Error && current.cause !== undefined && !seen.has(current)) {
    seen.add(current)
    current = current.cause
  }
  return current
}

/**
 * Description d'échec : message externe + cause racine, **le tout redacté**
 * (une URL, un mot de passe ou un identifiant peuvent s'y être glissés).
 */
function describeMigrationFailure(error: unknown): string {
  const outer = errorMessageOf(error)
  const root = rootCauseOf(error)
  const suffix = root === error ? '' : ` — cause racine : ${redactSecrets(errorMessageOf(root))}`
  return redactSecrets(`${outer}${suffix}`)
}

/**
 * Applique les migrations Drizzle (`drizzle/*.sql`) sur `databaseUrl`.
 *
 * Idempotent (le journal `__drizzle_migrations` fait foi) ; rejette sur tout
 * échec — jamais de démarrage sur un schéma partiel. Le message rejeté porte la
 * cause racine redactée et commence par « Les migrations ont échoué » (contrat
 * du dialogue `handleStartupFailure()` dans `main.ts`).
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  try {
    const migrationsFolder = resolveMigrationsFolder()
    log.info(`[migrate] dossier de migrations résolu : ${migrationsFolder}`)
    log.info(`[migrate] application des migrations sur ${redactSecrets(databaseUrl)} …`)

    const connection = postgres(databaseUrl, { max: 1 })
    try {
      await migrate(drizzle(connection), { migrationsFolder })
      log.info('[migrate] migrations appliquées (ou déjà à jour : opération idempotente)')
    } finally {
      await connection
        .end({ timeout: CONNECTION_END_TIMEOUT_S })
        .catch((error: unknown) => {
          log.warn(`[migrate] fermeture de la connexion impossible : ${redactSecrets(errorMessageOf(error))}`)
        })
    }
  } catch (error) {
    const failure = describeMigrationFailure(error)
    log.error(`[migrate] ${failure}`)
    // Jamais l'erreur brute en `cause` : `handleStartupFailure()` journalise
    // l'arbre complet, qui pourrait contenir l'URL (mot de passe) en clair.
    throw new Error(`Les migrations ont échoué : ${failure}`)
  }
}
