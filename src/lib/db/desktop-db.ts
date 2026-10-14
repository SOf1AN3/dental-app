/**
 * Tâche 5.4 — client Drizzle **PARESSEUX** du processus principal Electron.
 *
 * ## Pourquoi ce fichier existe (et pas `src/lib/db/db.ts`)
 *
 * `src/lib/db/db.ts` appelle `validateEnv()` **au top-level** : son simple
 * import plante si `DATABASE_URL` / `AUTH_SECRET` ne sont pas prêts au
 * chargement. C'est exactement le cas du processus **main** Electron (l'URL de
 * la base vit dans la config du poste, pas dans l'env Node du bundle). Le main
 * doit donc **interdire** tout import de `db.ts` et passer par ici.
 *
 * ## Contrats
 *
 *  - **Zéro `process.env` au top-level** (et aucun import de `db.ts`) : la
 *    connexion est **injectée** par l'appelant — `createDesktopDb(url)` reçoit
 *    l'URL du cluster local embarqué (embedded-postgres), décidée par le main.
 *  - **Pool réutilisable** : `postgres(url)` ouvre par défaut un pool de
 *    connexions ; une seule instance est conservée (singleton mémoïsé) pour
 *    toutes les transactions de synchronisation.
 *  - **Fermeture propre** : le pool est exposé par `closeDesktopDb` (→
 *    `db.$client.end()`), à appeler à l'arrêt du main.
 *  - **Testable** : `setDesktopDb(null)` réinitialise le singleton (tests /
 *    arrêt), `getDesktopDb()` renvoie `null` tant qu'aucune instance n'a été
 *    installée (l'appelant décide — jamais de création paresseuse cachée).
 *  - TypeScript strict, zéro `any`, **aucun log** (le journalisage appartient
 *    à l'orchestrateur, étape 5.5).
 *
 * Le schéma est importé depuis `./schema` (objets tables purs, sans connexion),
 * **jamais** `db.ts`.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Fabrique interne : **source unique** du type `DesktopDb`.
 * (Un type déduit de `createDesktopDb` elle-même créerait un cycle de type :
 * la fonction annoterait son retour avec le type qu'elle définit.)
 */
function buildDesktopDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

/** Instance Drizzle du poste : même shape que `db.ts`, mais sans env. */
export type DesktopDb = ReturnType<typeof buildDesktopDb>;

/** Singleton mémoïsé — `null` tant que le main n'a pas injecté l'instance. */
let singleton: DesktopDb | null = null;

/**
 * Ouvre une connexion (pool `postgres.js`) vers `databaseUrl` et construit le
 * client Drizzle associé, avec le schéma complet du projet.
 *
 * Chaque appel crée un **nouveau** pool : en pratique le main en appelle une
 * seule fois puis installe l'instance via `setDesktopDb`. Un appelant qui
 * remplace une instance existante doit fermer l'ancienne (`closeDesktopDb`)
 * pour ne pas laisser de pool ouvert.
 *
 * @param databaseUrl URL PostgreSQL **injectée** (jamais lue depuis l'env).
 * @throws `Error` si l'URL est absente ou vide (échec fermé, pas de log).
 */
export function createDesktopDb(databaseUrl: string): DesktopDb {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error(
      "db/desktop-db : URL de connexion absente ou vide — injection par l'appelant requise.",
    );
  }
  return buildDesktopDb(databaseUrl);
}

/**
 * Singleton courant, `null` si aucune instance n'a été installée.
 * L'appelant (main / orchestrateur 5.5) décide s'il doit le créer.
 */
export function getDesktopDb(): DesktopDb | null {
  return singleton;
}

/**
 * Installe (ou retire avec `null`) l'instance partagée — **tests et arrêt** du
 * main. Ne crée ni ne détruit aucun pool : voir `createDesktopDb` /
 * `closeDesktopDb`.
 */
export function setDesktopDb(db: DesktopDb | null): void {
  singleton = db;
}

/**
 * Ferme proprement le pool d'une instance et, s'il s'agitait du singleton,
 * le désinstalle (aucun use-after-close possible au redémarrage).
 * No-op sur `null`.
 */
export async function closeDesktopDb(db: DesktopDb | null): Promise<void> {
  if (!db) return;
  if (singleton === db) singleton = null;
  await db.$client.end({ timeout: 5 });
}
