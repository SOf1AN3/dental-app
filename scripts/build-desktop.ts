/**
 * Orchestration du build desktop (PLAN-ELECTRON §9 — tâche 9.1).
 *
 * Produit `dist-desktop/`, seule entrée consommée ensuite par
 * `electron-builder.yml` :
 *
 * ```
 * dist-desktop/
 * ├── app/              serveur Next autonome (output: "standalone")
 * │   ├── server.js     point d'entrée : `node server.js` (ELECTRON_RUN_AS_NODE)
 * │   ├── package.json
 * │   ├── .next/        artefacts serveur (issus du standalone) + .next/static copié
 * │   ├── node_modules/ sous-ensemble **épuré** tracé par Next (14 paquets ici)
 * │   └── public/       copié depuis <racine>/public
 * └── drizzle/          migrations (SQL + meta/_journal.json + snapshots)
 * ```
 *
 * Ces deux dossiers sont livrés **hors asar** via `extraResources` :
 *  - le serveur Next est **spawné** (`ELECTRON_RUN_AS_NODE=1 node server.js`) :
 *    un chemin sous `app.asar` n'est pas exécutable → `<resources>/standalone`,
 *    **premier** candidat de `standaloneCandidates()` (`electron/server/next.ts`) ;
 *  - le migrateur Drizzle lit `<resources>/drizzle/meta/_journal.json`, premier
 *    candidat de `migrationFolderCandidates()` (`electron/db/migrate.ts`).
 *
 * ## Garde-fous de sécurité (ce sont des garde-fous, pas des avertissements)
 *
 * Le build `standalone` de Next **recopie beaucoup trop** : `.env` (secrets),
 * `pgdata/` et `uploads/` (données médicales), `src/`, `audit/`, `*.md`, … y
 * figurent (constaté sur ce dépôt). Ce script n'en retient que la **liste
 * blanche** strictement nécessaire au runtime (`server.js`, `package.json`,
 * `.next/`, `node_modules/`), copie `public/`, `.next/static/` et `drizzle/`
 * depuis la racine projet, puis **vérifie** l'arborescence produite : la
 * moindre présence de `.env`, `pgdata`, `uploads`, `src`, `audit`, `*.md`, d'un
 * `node_modules` inattendu ou d'un `.ts` fait échouer le build (exit ≠ 0).
 * Jamais un artefact sale n'est livré au client.
 *
 * Windows : Next crée des **junctions** dans `standalone` (cible absolue,
 * non relogeable — ex. `.next/node_modules/@aws-sdk/client-s3-<hash>` →
 * `<racine>/node_modules/@aws-sdk/client-s3`). Toute copie passe donc par
 * `fs.cp` avec `dereference: true` (contenu copié, lien disparu) ; la
 * vérification finale refuse de terminer s'il restait un lien dans la sortie.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/* -------------------------------------------------------------------------- */
/* Contexte                                                                   */
/* -------------------------------------------------------------------------- */

/** Racine du projet : `npm run` place toujours le cwd à la racine du paquet. */
const PROJECT_ROOT = process.cwd()

const OUTPUT_DIR = 'dist-desktop'
/**
 * Conteneur copié **tel quel** vers `<resources>` (`extraResources.to: "."`).
 *
 * ⚠️ Le serveur standalone doit vivre dans `app/standalone/` et **pas**
 * directement dans `app/` : electron-builder (`out/util/filter.js`) **écarte
 * systématiquement un `node_modules` de premier niveau** de toute copie
 * (`if (relative === "node_modules") return false`), y compris pour
 * `extraResources`. Or `server.js` fait `require('next')` : sans
 * `standalone/node_modules/next`, l'application packagée planterait au
 * démarrage. En logeant le standalone dans `app/standalone/`, le chemin relatif
 * du dossier devient `standalone/node_modules` → conservé, et la résolution de
 * modules de Node remonte de `<resources>/standalone/server.js` vers
 * `<resources>/standalone/node_modules` (premier cran, trouvé).
 */
const APP_DIR = path.join(OUTPUT_DIR, 'app')
const STANDALONE_OUTPUT_DIR = path.join(APP_DIR, 'standalone')
const DRIZZLE_DIR = path.join(OUTPUT_DIR, 'drizzle')

/** `output: standalone` (next.config.ts lit `NEXT_OUTPUT`) alimente ce dossier. */
const STANDALONE_DIR = path.join('.next', 'standalone')
const STANDING_STATIC_DIR = path.join('.next', 'static')

/**
 * Contenu du `standalone` **nécessaire au runtime** (liste blanche).
 * Les documents Next (`output: "standalone"`) décrivent exactement cette
 * arborescence : `server.js` + artefacts `.next/` + `node_modules` épuré ;
 * `public/` et `.next/static/` doivent être copiés **depuis la racine projet**
 * (le standalone ne les contient pas).
 */
const STANDALONE_WHITELIST: readonly string[] = ['server.js', 'package.json', '.next', 'node_modules']

/** Dossiers de données/source strictement interdits dans l'artefact livré. */
const FORBIDDEN_DIRS = new Set(['pgdata', 'uploads', 'src', 'audit'])

/** Extensions de source TypeScript : jamais exécutables par Node au runtime. */
const TS_SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.cts', '.mts']

/**
 * Paquets **dev** qui ne doivent jamais figurer dans le `node_modules` épuré du
 * serveur standalone : leur présence signifierait qu'un `node_modules` complet
 * (celui du projet) s'est retrouvé copié dans l'artefact.
 */
const DEV_ONLY_PACKAGES: readonly string[] = [
  '@types',
  'cross-env',
  'drizzle-kit',
  'electron',
  'electron-builder',
  'electron-vite',
  'eslint',
  'eslint-config-next',
  'tailwindcss',
  'tsx',
  'typescript',
  'vitest',
]

/** Plafond de paquets de premier niveau du sous-ensemble tracé (14 aujourd'hui). */
const MAX_PRUNED_TOP_LEVEL_ENTRIES = 64

/** Fichiers/dossiers devant absolument exister dans l'artefact final. */
const REQUIRED_PATHS: readonly string[] = [
  path.join('app', 'standalone', 'server.js'),
  path.join('app', 'standalone', '.next', 'BUILD_ID'),
  path.join('app', 'standalone', 'node_modules', 'next', 'package.json'),
  path.join('app', 'standalone', 'public'),
  path.join('drizzle', 'meta', '_journal.json'),
]

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(message: string): void {
  console.log(`[build-desktop] ${message}`)
}

/** Échec explicite (le `catch` de `main()` sortira avec `exitCode = 1`). */
function fail(message: string): never {
  throw new Error(message)
}

/** Chemin projet relatif, séparateurs POSIX (messages + garde-fou). */
function toPosixRelative(fullPath: string): string {
  return path.relative(PROJECT_ROOT, fullPath).split(path.sep).join('/')
}

function isEnvFile(name: string): boolean {
  return name.toLowerCase().startsWith('.env')
}

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

function isTypeScriptFile(name: string): boolean {
  const lower = name.toLowerCase()
  return TS_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function toMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

/* -------------------------------------------------------------------------- */
/* Étape 1 — build Next (`output: "standalone"`)                              */
/* -------------------------------------------------------------------------- */

/**
 * `next build` avec `NEXT_OUTPUT=standalone`, forcé **dans l'enfant** pour que
 * l'exécution directe (`npx tsx scripts/build-desktop.ts`) produise le même
 * artefact que `npm run build:desktop` (cross-env).
 *
 * `process.execPath` + chemin absolu du binaire Next : aucun shell, donc pas
 * de différence `next` / `next.cmd` entre Windows et POSIX.
 */
function runNextBuild(): Promise<void> {
  const nextBinary = path.join(PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  if (!existsSync(nextBinary)) {
    fail(`binaire Next.js introuvable (${toPosixRelative(nextBinary)}) : exécutez \`npm install\`.`)
  }
  log('next build (NEXT_OUTPUT=standalone) …')
  return new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [nextBinary, 'build'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NEXT_OUTPUT: 'standalone' },
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', (error: Error) => {
      rejectBuild(new Error(`impossible de lancer \`next build\` : ${error.message}`))
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolveBuild()
        return
      }
      const reason = code === null ? `signal ${signal ?? 'inconnu'}` : `code ${code}`
      rejectBuild(new Error(`\`next build\` s'est arrêté (${reason}) — build desktop interrompu.`))
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Étape 2 — copies sécurisées                                                */
/* -------------------------------------------------------------------------- */

/**
 * Filtre commun à **toutes** les copis : refuse (donc écarte définitivement de
 * l'artefact) tout `.env*`, dossier `pgdata`/`uploads`/`src`/`audit`, tout
 * `.md`, toute source TypeScript et tout dossier `drizzle` (livré à part).
 * `fs.cp` appelle ce prédicat pour chaque entrée, dossiers compris : c'est une
 * **seconde barrière** derrière la liste blanche de `copyStandaloneApp()`.
 */
function artifactCopyFilter(source: string): boolean {
  const name = path.basename(source)
  if (isEnvFile(name) || isMarkdownFile(name) || isTypeScriptFile(name)) {
    return false
  }
  if (FORBIDDEN_DIRS.has(name) || name === 'drizzle') {
    return false
  }
  return true
}

/**
 * Copie `.next/standalone` → `dist-desktop/app` en **liste blanche** : seuls le
 * `server.js`, le `package.json`, `.next/` et `node_modules/` (sous-ensemble
 * épuré tracé par Next) sont retenus. Tout le reste du standalone (`.env`,
 * `pgdata/`, `uploads/`, `src/`, `audit/`, `*.md`, `electron/`, `scripts/`,
 * `dist-electron/`, `seed.ts`, `proxy.ts`, `tsconfig.json`, …) est écarté d'office.
 */
async function copyStandaloneApp(): Promise<void> {
  const sourceRoot = path.join(PROJECT_ROOT, STANDALONE_DIR)
  if (!existsSync(sourceRoot)) {
    fail(`${STANDALONE_DIR}/ introuvable : le build Next ne l'a pas produit.`)
  }
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const names = new Set(entries.map((entry) => entry.name))
  if (!names.has('server.js')) {
    fail(`${STANDALONE_DIR}/server.js introuvable : build standalone incomplet.`)
  }
  const missing = STANDALONE_WHITELIST.filter((name) => !names.has(name))
  if (missing.length > 0) {
    fail(`${STANDALONE_DIR}/ est incomplet (absent : ${missing.join(', ')}).`)
  }

  const destinationRoot = path.join(PROJECT_ROOT, STANDALONE_OUTPUT_DIR)
  await rm(destinationRoot, { recursive: true, force: true })
  for (const name of STANDALONE_WHITELIST) {
    await cp(path.join(sourceRoot, name), path.join(destinationRoot, name), {
      recursive: true,
      // Windows : `.next/standalone/.next/node_modules/@aws-sdk/client-s3-<hash>`
      // est une **junction** vers `<racine>/node_modules/@aws-sdk/client-s3`
      // (cible absolue, non relogeable). Sans déréférencement, l'artefact
      // contiendrait un lien mort au lieu du contenu.
      dereference: true,
      force: true,
      filter: artifactCopyFilter,
    })
  }
  log(`standalone copié → ${APP_DIR}/ (liste blanche : ${STANDALONE_WHITELIST.join(', ')})`)
}

/**
 * Les deux copies que le standalone **ne contient pas** (documentées par Next) :
 * `.next/static` et `public/`, servis automatiquement par `server.js` dont le
 * cwd est le dossier de l'artefact.
 */
async function copyStaticAndPublic(): Promise<void> {
  const standaloneRoot = path.join(PROJECT_ROOT, STANDALONE_OUTPUT_DIR)
  const commonOptions = {
    recursive: true,
    dereference: true,
    force: true,
    filter: artifactCopyFilter,
  } as const

  const staticSource = path.join(PROJECT_ROOT, STANDING_STATIC_DIR)
  if (!existsSync(staticSource)) {
    fail(`${STANDING_STATIC_DIR}/ introuvable : le build Next est incomplet.`)
  }
  await cp(staticSource, path.join(standaloneRoot, '.next', 'static'), commonOptions)

  const publicSource = path.join(PROJECT_ROOT, 'public')
  if (!existsSync(publicSource)) {
    fail('dossier public/ introuvable à la racine du projet.')
  }
  await cp(publicSource, path.join(standaloneRoot, 'public'), commonOptions)

  log(`${STANDING_STATIC_DIR} → ${STANDALONE_OUTPUT_DIR}/.next/static , public/ → ${STANDALONE_OUTPUT_DIR}/public`)
}

/**
 * Migrations Drizzle → `dist-desktop/drizzle` : **uniquement** les `.sql` et
 * `meta/*.json` (journal + snapshots) — rien d'autre n'a besoin d'être livré,
 * et le migrateur exige `meta/_journal.json`.
 */
async function copyMigrations(): Promise<void> {
  const sourceRoot = path.join(PROJECT_ROOT, 'drizzle')
  const destinationRoot = path.join(PROJECT_ROOT, DRIZZLE_DIR)
  if (!existsSync(sourceRoot)) {
    fail('dossier drizzle/ introuvable à la racine du projet.')
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const migrations = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  if (migrations.length === 0) {
    fail('aucune migration `.sql` trouvée dans drizzle/.')
  }

  const metaSource = path.join(sourceRoot, 'meta')
  if (!existsSync(metaSource)) {
    fail('dossier drizzle/meta/ introuvable.')
  }
  const metaEntries = await readdir(metaSource, { withFileTypes: true })
  const metaFiles = metaEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  if (!metaFiles.some((entry) => entry.name === '_journal.json')) {
    fail('drizzle/meta/_journal.json introuvable : le migrateur Drizzle exige ce journal.')
  }

  await rm(destinationRoot, { recursive: true, force: true })
  await mkdir(path.join(destinationRoot, 'meta'), { recursive: true })
  for (const migration of migrations) {
    await cp(path.join(sourceRoot, migration.name), path.join(destinationRoot, migration.name))
  }
  for (const metaFile of metaFiles) {
    await cp(path.join(metaSource, metaFile.name), path.join(destinationRoot, 'meta', metaFile.name))
  }
  log(`migrations copiées → ${DRIZZLE_DIR}/ (${migrations.length} .sql, ${metaFiles.length} JSON meta)`)
}

/* -------------------------------------------------------------------------- */
/* Étape 3 — garde-fou final                                                  */
/* -------------------------------------------------------------------------- */

interface Violation {
  readonly relativePath: string
  readonly reason: string
}

interface AuditResult {
  readonly violations: readonly Violation[]
  readonly fileCount: number
  readonly totalBytes: number
}

/**
 * Vérification **obligatoire** de `dist-desktop/` : la moindre violation fait
 * échouer le script (exit ≠ 0). Contrôles :
 *  - aucun `.env*`, aucun `pgdata`/`uploads`/`src`/`audit`, aucun `*.md`,
 *    aucune source TypeScript, aucun lien symbolique/junction résiduel ;
 *  - `node_modules` uniquement sous `app/` (sous-ensemble tracé), et **épuré**
 *    (paquets dev interdits, plafond d'entrées de premier niveau) ;
 *  - `drizzle` uniquement à `dist-desktop/drizzle/` ;
 *  - présence effective de `server.js`, `.next/BUILD_ID`, `.next/static`,
 *    `public/`, `node_modules/next`, `drizzle/meta/_journal.json` et d'au
 *    moins une migration.
 */
async function auditOutput(): Promise<AuditResult> {
  const root = path.join(PROJECT_ROOT, OUTPUT_DIR)
  if (!existsSync(root)) {
    fail(`${OUTPUT_DIR}/ introuvable après copie.`)
  }
  const appRoot = path.join(root, 'app')
  const standaloneRoot = path.join(appRoot, 'standalone')
  const violations: Violation[] = []
  let fileCount = 0
  let totalBytes = 0

  const record = (relativePath: string, reason: string): void => {
    violations.push({ relativePath, reason })
  }
  // Le `node_modules` tracé doit rester sous `app/standalone/` : ailleurs dans
  // l'artefact, il indiquerait qu'un arbre complet s'est glissé dans la copie.
  const isUnderStandalone = (fullPath: string): boolean =>
    !path.relative(standaloneRoot, fullPath).startsWith('..')

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/')

      if (entry.isSymbolicLink()) {
        record(relativePath, 'lien symbolique/junction résiduel : la copie doit être déréférencée')
        continue
      }
      if (isEnvFile(entry.name)) {
        record(relativePath, 'fichier .env : secrets jamais livrés au client')
        continue
      }
      if (isMarkdownFile(entry.name)) {
        record(relativePath, 'documentation (.md) : jamais livrée au client')
      }
      if (isTypeScriptFile(entry.name)) {
        record(relativePath, 'source TypeScript : jamais livrée au client')
      }

      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRS.has(entry.name)) {
          record(relativePath, 'dossier interdit (données médicales ou code source)')
          continue
        }
        if (entry.name === 'node_modules' && !isUnderStandalone(fullPath)) {
          record(relativePath, 'node_modules hors app/standalone/ : seul le sous-ensemble tracé est livré')
          continue
        }
        if (entry.name === 'drizzle' && relativePath !== 'drizzle') {
          record(relativePath, 'drizzle livré ailleurs que dist-desktop/drizzle/')
          continue
        }
        await walk(fullPath)
        continue
      }
      if (entry.isFile()) {
        fileCount += 1
        totalBytes += (await stat(fullPath)).size
      }
    }
  }

  await walk(root)

  // Sous-ensemble tracé : le seul `node_modules` autorisé doit rester épuré.
  const prunedModules = path.join(standaloneRoot, 'node_modules')
  if (!existsSync(prunedModules)) {
    record(
      path.join('app', 'standalone', 'node_modules'),
      'absent : server.js requiert `next` depuis ce sous-ensemble',
    )
  } else {
    const topLevel = (await readdir(prunedModules, { withFileTypes: true })).map((entry) => entry.name)
    if (topLevel.length > MAX_PRUNED_TOP_LEVEL_ENTRIES) {
      record(
        path.join('app', 'standalone', 'node_modules'),
        `node_modules non épollé : ${topLevel.length} entrées de premier niveau (plafond ${MAX_PRUNED_TOP_LEVEL_ENTRIES})`,
      )
    }
    const devOnly = topLevel.filter((name) => DEV_ONLY_PACKAGES.includes(name))
    if (devOnly.length > 0) {
      record(
        path.join('app', 'standalone', 'node_modules'),
        `paquets de développement présents : ${devOnly.join(', ')}`,
      )
    }
  }

  // Présences obligatoires (échec fermé : jamais d'artefact incomplet).
  for (const requiredPath of REQUIRED_PATHS) {
    if (!existsSync(path.join(root, requiredPath))) {
      record(requiredPath, 'fichier/dossier obligatoire manquant')
    }
  }
  const staticDirectory = path.join(standaloneRoot, '.next', 'static')
  const staticEntries = existsSync(staticDirectory) ? await readdir(staticDirectory) : []
  if (staticEntries.length === 0) {
    record(
      path.join('app', 'standalone', '.next', 'static'),
      'dossier vide : .next/static doit être copié depuis la racine projet',
    )
  }
  const drizzleRoot = path.join(root, 'drizzle')
  const sqlMigrations = existsSync(drizzleRoot)
    ? (await readdir(drizzleRoot)).filter((name) => name.endsWith('.sql'))
    : []
  if (sqlMigrations.length === 0) {
    record('drizzle', 'aucune migration .sql livrée')
  }

  return { violations, fileCount, totalBytes }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                             */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(path.join(PROJECT_ROOT, 'package.json')) || !existsSync(path.join(PROJECT_ROOT, 'next.config.ts'))) {
    fail(`cwd inattendu (${PROJECT_ROOT}) : lancez ce script depuis la racine du projet (\`npm run build:desktop\`).`)
  }
  log(`racine du projet : ${PROJECT_ROOT}`)

  await runNextBuild()
  if (!existsSync(path.join(PROJECT_ROOT, STANDALONE_DIR, 'server.js'))) {
    fail(`${STANDALONE_DIR}/server.js absent après build : sortie standalone non produite.`)
  }

  log(`nettoyage de ${OUTPUT_DIR}/ …`)
  await rm(path.join(PROJECT_ROOT, OUTPUT_DIR), { recursive: true, force: true })
  await mkdir(path.join(PROJECT_ROOT, OUTPUT_DIR), { recursive: true })

  await copyStandaloneApp()
  await copyStaticAndPublic()
  await copyMigrations()

  log('vérification finale (garde-fou de sécurité) …')
  const audit = await auditOutput()

  const standaloneEntries = await readdir(path.join(PROJECT_ROOT, STANDALONE_OUTPUT_DIR))
  const drizzleEntries = await readdir(path.join(PROJECT_ROOT, DRIZZLE_DIR))
  log(`${OUTPUT_DIR}/app/standalone : ${standaloneEntries.sort().join(', ')}`)
  log(`${OUTPUT_DIR}/drizzle : ${drizzleEntries.length} entrées (journal + snapshots + .sql)`)

  if (audit.violations.length > 0) {
    console.error(`[build-desktop] ÉCHEC — ${audit.violations.length} violation(s) détectée(s) dans ${OUTPUT_DIR}/ :`)
    for (const violation of audit.violations.slice(0, 50)) {
      console.error(`  - ${violation.relativePath} : ${violation.reason}`)
    }
    if (audit.violations.length > 50) {
      console.error(`  … et ${audit.violations.length - 50} autre(s)`)
    }
    console.error("[build-desktop] Aucun artefact n'est livré : corrigez le build desktop puis relancez.")
    process.exitCode = 1
    return
  }

  log(`OK — ${audit.fileCount} fichiers, ${toMegabytes(audit.totalBytes)}, aucune donnée sensible détectée.`)
}

main().catch((error: unknown) => {
  console.error(`[build-desktop] ÉCHEC : ${errorMessageOf(error)}`)
  process.exitCode = 1
})
