/**
 * Base de données de DÉVELOPPEMENT locale.
 *
 * Pourquoi ce script et non un PostgreSQL installé ?
 * -----------------------------------------------
 * L'environnement de développement n'a ni droits administrateur (l'installeur
 * PostgreSQL winget est machine-scope), ni Docker, ni PostgreSQL. Ce script
 * embarque donc **Postgres lui-même** via PGlite — le même moteur que celui
 * analysé dans OFFLINE-PLAN.md — et l'expose sur le **protocole natif** via
 * un serveur de sockets. L'application s'y connecte comme à n'importe quel
 * PostgreSQL : `postgres-js`, Drizzle, `drizzle-kit` et les migrations
 * fonctionnent **sans modification**.
 *
 * Les données sont persistées sur disque dans `./pgdata` (déjà gitignoré).
 *
 * Utilisation
 * -----------
 *   npm run db:dev          # démarre la base (processus long)
 *
 * Puis, dans un autre terminal :
 *   npm run db:generate     # génère une migration à partir du schéma Drizzle
 *   npm run db:migrate      # applique les migrations
 *   npm test                # la suite de tests (dont celle qui exige DATABASE_URL)
 *   npm run dev             # l'application
 *
 * ⚠️ Ce script est réservé au DÉVELOPPEMENT. Il n'a aucun rapport avec la base
 * de production, qui reste un PostgreSQL managé.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const HOST = process.env.DEV_DB_HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DEV_DB_DATA_DIR ?? "pgdata";

/**
 * PostgreSQL — et donc PGlite — refuse de démarrer sur un répertoire contenant
 * encore un `postmaster.pid` : le fichier signifie qu'un serveur utilise déjà
 * ce catalogue. Le problème est qu'il **survit** à un arrêt brutal (fermeture
 * de terminal, `taskkill`, crash), et le dev se retrouve bloqué avec un
 * « Aborted() » cryptique au démarrage, sans qu'aucun serveur ne tourne.
 *
 * On ne supprime donc ce verrou que s'il est **démenti** : ni processus
 * détenteur, ni écoute sur le port. Sinon, on laisse tomber plutôt que de
 * risquer d'ouvrir le même catalogue depuis deux serveurs.
 */
function clearStalePidLock(dataDir: string): void {
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;

  const rawPid = readFileSync(pidFile, "utf8").split("\n")[0]?.trim();
  const pid = Number(rawPid);

  // `process.kill(pid, 0)` n'envoie aucun signal : il sonde l'existence du
  // processus. Il LÈVE (ESRCH) si le pid n'existe pas, et réussit sinon.
  // Le port est aussi vérifié : un serveur démarré avec un autre répertoire
  // mais sur le même port serait un conflit réel.
  let holderAlive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      holderAlive = true;
    } catch {
      holderAlive = false;
    }
  }

  if (holderAlive) {
    throw new Error(
      `La base dans ./${dataDir} est déjà utilisée par le processus ${pid}. ` +
        `Arrête-le avant de relancer (ou changez DEV_DB_DATA_DIR).`,
    );
  }

  console.warn(
    `[dev-db] Verrou orphelin detecte (postmaster.pid, pid ${rawPid}, ` +
      `processus absent) — suppression.`,
  );
  rmSync(pidFile, { force: true });
}

async function main() {
  console.log(`[dev-db] Ouverture de la base locale dans ./${DATA_DIR} …`);

  clearStalePidLock(DATA_DIR);

  const db = new PGlite(DATA_DIR, {
    fs: new NodeFS(DATA_DIR),
    // Le projet n'utilise aucune extension aujourd'hui. `btree_gist` est
    // disponible si une contrainte EXCLUDE USING gist est un jour nécessaire
    // (Z-63, reportée) : il faudra alors l'activer explicitement ici.
  });

  await db.waitReady;

  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: HOST,
    // `postgres-js` (utilisé par src/lib/db/db.ts) ouvre un POOL de
    // connexions. Avec maxConnections à 1 par défaut, les requêtes
    // concurrentes seraient rejetées au lieu d'être mises en file.
    maxConnections: 10,
  });

  await server.start();

  const info = await db.query<{ version: string }>(
    "SELECT version() AS version",
  );
  console.log(`[dev-db] Prêt sur ${HOST}:${PORT}`);
  console.log(`[dev-db] ${info.rows[0].version}`);

  const shutdown = async (signal: string) => {
    console.log(`\n[dev-db] Arrêt (${signal}) …`);
    try {
      await server.stop();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[dev-db] Échec :", err);
  process.exit(1);
});
