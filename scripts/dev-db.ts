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

import { PGlite } from "@electric-sql/pglite";
import { nodeFileSystem } from "@electric-sql/pglite/nodefs";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const HOST = process.env.DEV_DB_HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DEV_DB_DATA_DIR ?? "pgdata";

async function main() {
  console.log(`[dev-db] Ouverture de la base locale dans ./${DATA_DIR} …`);

  const db = new PGlite(DATA_DIR, {
    fs: nodeFileSystem,
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
