/**
 * Base de données de DÉVELOPPEMENT locale.
 *
 * Pourquoi un PostgreSQL embarqué plutôt que PostgreSQL installé ?
 * --------------------------------------------------------------
 * L'environnement de développement n'a ni droits administrateur (l'installeur
 * winget PostgreSQL est machine-scope), ni Docker, ni PostgreSQL. Ce script
 * embarque donc les **vrais binaires PostgreSQL** via `embedded-postgres` et
 * les exécute comme un processus enfant. Aucune installation système, aucun
 * service Windows.
 *
 * ⚠️ Un premier choix a été PGlite (Postgres en WebAssembly) exposé sur le
 * protocole natif. Il a été **abandonné** après vérification en conditions
 * réelles : son serveur socket sérialise les requêtes au niveau du MESSAGE,
 * pas de la CONNEXION. Deux transactions concurrentes sur deux connexions
 * s'interpénètrent et corrompent le protocole étendu — erreur
 * `portal "" does not exist`. Or ce projet utilise de nombreuses transactions
 * à verrous (`SELECT ... FOR UPDATE`) : inadapté.
 *
 * Utilisation
 * -----------
 *   npm run db:dev          # démarre la base (processus long)
 *
 * Puis, dans un autre terminal :
 *   npm run db:migrate      # applique les migrations
 *   npm test                # la suite de tests
 *   npm run dev             # l'application
 *
 * ⚠️ Réservé au DÉVELOPPEMENT. Aucun rapport avec la base de production.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DATA_DIR ?? "pgdata";
const USER = process.env.DEV_DB_USER ?? "postgres";
const PASSWORD = process.env.DEV_DB_PASSWORD ?? "devpassword";

/**
 * Vrai si le pid désigné est réellement un serveur PostgreSQL.
 *
 * Un pid peut être **recyclé** par l'OS après l'arrêt brutal de PostgreSQL :
 * `process.kill(pid, 0)` répond alors « vivant » alors que le détenteur du
 * verrou n'existe plus. Conclure « la base est déjà utilisée » sur la seule
 * existence du pid bloquerait le démarrage **à jamais** (cas constaté : le pid
 * de `postmaster.pid` hébergé par un processus `node` totalement étranger).
 * Même garde que `electron/db/embedded-pg.ts` (durcissement issu des revues).
 *
 * En cas de doute (outillage absent, échec de `tasklist`), on retourne `true`
 * : on préfère refuser de démarrer plutôt que d'ouvrir deux fois un catalogue.
 */
function isPostgresProcess(pid: number): boolean {
  if (process.platform !== "win32") return true;
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    return out.includes("postgres.exe");
  } catch {
    return true;
  }
}

/**
 * PostgreSQL refuse de démarrer sur un répertoire contenant encore un
 * `postmaster.pid` : le fichier signale un serveur déjà détenteur du
 * catalogue. Il **survit** à un arrêt brutal (fermeture de terminal,
 * `taskkill`, crash) et bloque alors tout redémarrage avec un message
 * cryptique.
 *
 * On ne supprime ce verrou que s'il est **démenti** : ni processus
 * détenteur. Sinon on abandonne plutôt que d'ouvrir deux fois le même
 * catalogue.
 */
function clearStalePidLock(dataDir: string): void {
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;

  const rawPid = readFileSync(pidFile, "utf8").split("\n")[0]?.trim();
  const pid = Number(rawPid);

  // `process.kill(pid, 0)` n'envoie aucun signal : il sonde l'existence du
  // processus et LÈVE (ESRCH) si le pid n'existe pas.
  let holderAlive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      holderAlive = true;
    } catch {
      holderAlive = false;
    }
  }

  // Un pid "vivant" qui n'est PAS un postgres.exe est un pid RECYCLE par l'OS :
  // le verrou est orphelin et doit etre supprime (cf. isPostgresProcess).
  if (holderAlive && !isPostgresProcess(pid)) {
    console.warn(
      `[dev-db] Verrou orphelin : le pid ${rawPid} existe mais n'est plus un ` +
        `postgres.exe (recyclage par l'OS) — suppression du verrou.`,
    );
    rmSync(pidFile, { force: true });
    return;
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
  console.log(`[dev-db] Preparation de la base locale dans ./${DATA_DIR} …`);

  clearStalePidLock(DATA_DIR);

  const needsInitialisation = !existsSync(join(DATA_DIR, "PG_VERSION"));

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    authMethod: "scram-sha-256",
    persistent: true,
    // initdb hérite de la locale système (ici French_France.1252) et en
    // déduit WIN1252 comme encodage par défaut. Win1252 couvre le latin-1
    // (accents français OK) mais PAS l'au-delà : postgres-js émet de
    // l'UTF-8, donc tout caractère hors latin-1 (arabe, emoji, certains
    // noms) serait réinterprété et corrompu silencieusement. C'est une
    // application médicale en Algérie — on force UTF-8.
    initdbFlags: ["--encoding=UTF8", "--no-locale"],
    postgresFlags: [
      // Ecoute sur l'interface de bouclage uniquement.
      "-c",
      "listen_addresses=127.0.0.1",
      // Convention d'horodatage UNIQUE (Q-8) : Drizzle écrit/lit de l'UTC,
      // sans quoi defaultNow() (heure locale) et $onUpdate (UTC) coexistent
      // dans la meme colonne et `updated_at` peut RECULER apres une mise a
      // jour -> le curseur de pull perd alors la mise a jour a jamais.
      // Meme drapeau que electron/db/embedded-pg.ts.
      "-c",
      "timezone=UTC",
    ],
    onLog: (m) => console.log(`[postgres] ${m}`),
    onError: (m) => console.error(`[postgres] ${m}`),
  });

  if (needsInitialisation) {
    console.log("[dev-db] Premier demarrage — initialisation du catalogue …");
    await pg.initialise();
  }

  await pg.start();

  console.log(`[dev-db] Pret sur 127.0.0.1:${PORT}`);
  console.log(`[dev-db] Utilisateur : ${USER}`);
  console.log("[dev-db] Arret propre : Ctrl+C (un arret brutal laisse un verrou)");

  const shutdown = (signal: string) => {
    console.log(`\n[dev-db] Arret (${signal}) …`);
    pg.stop()
      .catch((e) => console.error("[dev-db] Arret impropore :", e))
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[dev-db] Echec :", err);
  process.exit(1);
});
