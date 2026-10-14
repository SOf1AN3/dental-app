/**
 * Tâche 5.5 — CŒUR D'ORCHESTRATION de la synchronisation (étape 6 du plan).
 *
 * `runSyncCycle` enchaîne **un cycle complet** de synchronisation local-first :
 * garde-fous (baseUrl, cadence, cabinet) → probe réseau → jeton → **push** de
 * l'outbox → **pull** du central → application locale → avance du curseur.
 *
 * Conception (même style que `net.ts` / `outbox.ts` / `local-apply.ts`) :
 *  - **TypeScript pur, toutes les dépendances injectées** (`SyncRunnerDeps`) :
 *    probe, ordonnanceur, repos d'outbox (mémoire en test, Drizzle en prod),
 *    jeton, `fetch`, horloge et journal. Aucune I/O directe, **zéro `console`**.
 *  - Le module est consommé par `electron/sync/runner.ts` (câblage réel,
 *    étape 5.5) et testé de façon **hermétique** par `runner-core.test.ts`.
 *
 * ## Ordre des étapes (CONTRAT — ne pas réordonner)
 *
 *  1. `baseUrl` absente → `idle-no-base-url` : **zéro** requête réseau et
 *     **aucun** compteur d'échec incrémenté (un poste sans central configuré
 *     n'est pas « en panne » — l'absence de central est un état nominal) ;
 *  2. `scheduler.shouldRun()` faux → `noop` immédiat (backoff en cours : rien
 *     n'est consommé, aucun réseau) ;
 *  3. `clinicId` absent → `needs-clinic` : la synchronisation porte sur le
 *     **cabinet actif**, choisi par l'UI (étape 7) — aucune requête avant de le
 *     connaître ;
 *  4. probe `false` → `offline` + `scheduler.registerFailure()` (backoff) ;
 *  5. jeton **absent ou expiré** (`expiresAt ≤ now`) → `needs-auth` +
 *     `scheduler.registerSuccess()`. Aucune demande de login automatique :
 *     l'acquisition du jeton est un **acte utilisateur** (étape 7).
 *     **Le jeton n'est jamais journalisé** (pas sa valeur, pas son hash) ;
 *  6. **push** : `pendingBatch(MAX_PUSH_OPS)` → `POST {baseUrl}/api/sync/push`
 *     (`Authorization: Bearer <jeton>`) → chaque `accepted` → `markSent`,
 *     chaque `rejected` → `markFailed(reason)`. **401** → `token.clear()` +
 *     `needs-auth`. Erreur réseau/HTTP → `markFailed` sur **tout le lot** +
 *     `registerFailure()` ;
 *  7. **pull** : `readCursor()` → `POST {baseUrl}/api/sync/pull` →
 *     `applyChanges(changes)` → **`writeCursor` TOUJOURS après**, quoi qu'il
 *     arrive (y compris si `applyChanges` rejette : une ligne empoisonnée qui
 *     ne ferait pas avancer le curseur bouclerait à chaque cycle) ;
 *  8. succès → `scheduler.registerSuccess()` + résultat consolidé.
 *
 * ## Résultats (`SyncCycleResult`)
 *
 *  - `pushed`  — un lot est parti et le tirage n'a rien rapporté ;
 *  - `pulled`  — le tirage a rapporté des changements (les compteurs de push
 *    sont alors portés par les **journaux**, pas par le résultat — voir `info`
 *    du push, toujours émis) ;
 *  - `noop`    — « rien à pousser ni à tirer », **ou** refus de cycle (backoff,
 *    mutex) : `reason` (facultatif) documente le refus ;
 *  - `error`   — `reason` **rédigé** via `redactError` : jamais de jeton,
 *    jamais de `DATABASE_URL`, messages bornés.
 *
 * ## Mutex (cycles concurrents)
 *
 * Un seul cycle à la fois : l'état est **module-local**. Un second appel
 * pendant qu'un cycle est en vol est **refusé immédiatement** (`noop` +
 * `reason: "concurrent-cycle"`) sans rien consommer — outbox et curseur ne sont
 * pas réentrants. Le verrou est relâché dans un `finally` (aucun cycle ne peut
 * le « fuir ») ; `isSyncCycleRunning()` l'observe depuis l'extérieur.
 *
 * ## Journalisation
 *
 * Zéro `console` : tout passe par `logger` (injecté ; `electron-log` en
 * production, capture mémoire en test). Les fragments d'erreur (réseau, HTTP)
 * transitent par `redactError` (retrait des `Bearer`, `token=`, `password=`…
 * et troncature) : un message de pile ne peut pas devenir un canal de fuite.
 */

import type { NetProbe, SyncScheduler } from "./net";
import { redactError } from "./outbox";
import {
  DEFAULT_PULL_LIMIT,
  MAX_PUSH_OPS,
  pullResponseSchema,
  pushResponseSchema,
  type ChangeOp,
  type Cursor,
  type PushRequest,
} from "./protocol";

/* -------------------------------------------------------------------------- */
/* 1. Types des dépendances (toutes injectées)                                */
/* -------------------------------------------------------------------------- */

/** Journal injecté — `electron-log` en production, capture en test. */
export interface SyncLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Façade d'outbox consommée par le cœur : les fonctions de `outbox.ts`
 * **pré-liées** au repo (Drizzle en prod, mémoire en test). Le cœur n'a
 * connaissance d'aucun SQL.
 */
export interface SyncOutboxApi {
  pendingBatch(limit: number): Promise<ChangeOp[]>;
  markSent(opIds: string[]): Promise<void>;
  markFailed(opId: string, error: string): Promise<void>;
  readCursor(): Promise<Cursor | null>;
  writeCursor(cursor: Cursor): Promise<void>;
}

/**
 * Stockage du jeton d'appareil (chiffré `safeStorage` côté Electron).
 * `write` est exposé pour l'échange d'habilitation (étape 7) : le cœur, lui,
 * **n'écrit jamais** un jeton — seule la perte d'habilitation (`clear`) lui
 * appartient (401).
 */
export interface SyncTokenStore {
  read(): { token: string; expiresAt: string } | null;
  write(token: string, expiresAt: string): void;
  clear(): void;
}

/**
 * Résultat d'application locale — shape allégée de `ApplyResult`
 * (`local-apply.ts`) pour ne pas coupler le cœur au détail des sauts.
 * `skipped` agrège `skippedPending + skippedUnknown + errors`.
 */
export interface ApplyResultLike {
  applied: number;
  skippedPending?: number;
  skippedUnknown?: number;
  errors?: readonly { readonly reason: string }[];
}

/** Toutes les dépendances du cycle — **aucune** n'est créée dans ce module. */
export interface SyncRunnerDeps {
  /** Origine du central ; `undefined` → cycle `idle-no-base-url` (étape 1). */
  baseUrl: string | undefined;
  /** Cabinet actif porté par l'UI (étape 7) ; `null` → `needs-clinic`. */
  clinicId: string | null;
  /** Identifiant d'appareil persisté (`resolveDeviceId`). */
  deviceId: string;
  probe: NetProbe;
  scheduler: SyncScheduler;
  outbox: SyncOutboxApi;
  token: SyncTokenStore;
  applyChanges(ops: ChangeOp[]): Promise<ApplyResultLike>;
  fetchImpl: typeof fetch;
  now(): Date;
  logger: SyncLogger;
}

/* -------------------------------------------------------------------------- */
/* 2. Résultat d'un cycle                                                      */
/* -------------------------------------------------------------------------- */

export type SyncCycleResult =
  | { status: "idle-no-base-url" }
  | { status: "offline" }
  /** Jeton absent ou expiré (ou 401 en cours de cycle — jeton effacé). */
  | { status: "needs-auth" }
  /** Aucun cabinet actif sélectionné (l'UI choisit le cabinet, étape 7). */
  | { status: "needs-clinic" }
  | { status: "pushed"; accepted: number; rejected: number }
  | { status: "pulled"; applied: number; skipped: number }
  /** Rien à pousser ni à tirer, **ou** refus de cycle (`reason` facultatif). */
  | { status: "noop"; reason?: string }
  | { status: "error"; reason: string };

/* -------------------------------------------------------------------------- */
/* 3. Constantes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bornes des requêtes `push`/`pull` : le probe a la sienne (3 s), mais un
 * `fetch` sans timeout pourrait **suspendre le cycle indéfiniment** (verrou
 * mutex tenu, aucun rejeu). Un abort se comporte comme une erreur réseau :
 * `markFailed` + backoff.
 */
export const SYNC_REQUEST_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* 4. Mutex                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` tant qu'un cycle est en vol (verrou module-local). */
let cycleInFlight = false;

/** Observe le verrou — utile au statut (`sync:status`) et aux tests. */
export function isSyncCycleRunning(): boolean {
  return cycleInFlight;
}

/* -------------------------------------------------------------------------- */
/* 5. Helpers                                                                 */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Motif d'erreur **rédigé** (jamais de secret, borné à 500 car. par `redactError`). */
function redactedReason(prefix: string, error: unknown): string {
  return `${prefix} : ${redactError(messageOf(error))}`;
}

/** Étiquette d'URL sûre : origine seule (pas de chemin, pas d'identifiants). */
function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "(origine illisible)";
  }
}

/** Initialisation commune des requêtes centrales (jamais de jeton dans le corps). */
function bearerHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. Phase push                                                               */
/* -------------------------------------------------------------------------- */

type PushOutcome =
  | {
      kind: "continue";
      /** `true` si un lot a été soumis au central. */
      pushed: boolean;
      accepted: number;
      rejected: number;
    }
  | { kind: "stop"; result: SyncCycleResult };

/** Marque tout un lot en échec — une défaillance de marquage n'interrompt pas le cycle. */
async function markBatchFailed(
  deps: SyncRunnerDeps,
  ops: readonly ChangeOp[],
  reason: string,
): Promise<void> {
  for (const op of ops) {
    try {
      await deps.outbox.markFailed(op.opId, reason);
    } catch (error) {
      deps.logger.error(
        `marquage impossible pour l'opération ${op.opId} : ${redactError(messageOf(error))}`,
      );
    }
  }
}

async function runPush(
  deps: SyncRunnerDeps,
  base: string,
  token: string,
): Promise<PushOutcome> {
  const { logger, scheduler, outbox } = deps;

  let batch: ChangeOp[];
  try {
    batch = await outbox.pendingBatch(MAX_PUSH_OPS);
  } catch (error) {
    scheduler.registerFailure();
    const reason = redactedReason("outbox illisible", error);
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  if (batch.length === 0) {
    return { kind: "continue", pushed: false, accepted: 0, rejected: 0 };
  }

  const body: PushRequest = {
    deviceId: deps.deviceId,
    clinicId: deps.clinicId,
    ops: batch,
  };

  let response: Response;
  try {
    response = await deps.fetchImpl(`${base}/api/sync/push`, {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Réseau absent / timeout : le lot reste `pending` (rejeu idempotent).
    const reason = redactedReason("push impossible", error);
    await markBatchFailed(deps, batch, reason);
    scheduler.registerFailure();
    logger.warn(`${reason} — ${batch.length} opération(s) marquée(s) en échec, backoff armé`);
    return { kind: "stop", result: { status: "error", reason } };
  }

  if (response.status === 401) {
    // Habilitation perdue : effacement + ré-authentification utilisateur.
    // Aucun état d'outbox n'est modifié ici — le lot reste `pending` et sera
    // rejeu après ré-authentification (l'application centrale est idempotente).
    deps.token.clear();
    scheduler.registerSuccess();
    logger.warn("push refusé (HTTP 401) : jeton effacé, ré-authentification requise");
    return { kind: "stop", result: { status: "needs-auth" } };
  }

  if (!response.ok) {
    const reason = `push refusé (HTTP ${response.status})`;
    await markBatchFailed(deps, batch, reason);
    scheduler.registerFailure();
    logger.error(`${reason} — ${batch.length} opération(s) marquée(s) en échec`);
    return { kind: "stop", result: { status: "error", reason } };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    const reason = redactedReason("réponse push illisible", error);
    await markBatchFailed(deps, batch, reason);
    scheduler.registerFailure();
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  const parsed = pushResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = "réponse push non conforme au protocole";
    await markBatchFailed(deps, batch, reason);
    scheduler.registerFailure();
    logger.error(`${reason} — ${batch.length} opération(s) marquée(s) en échec`);
    return { kind: "stop", result: { status: "error", reason } };
  }

  const { accepted, rejected } = parsed.data;
  try {
    await outbox.markSent(accepted);
    for (const entry of rejected) {
      // `markFailed` rédige et borne le motif côté outbox.
      await outbox.markFailed(entry.opId, entry.reason);
    }
  } catch (error) {
    // Le central a appliqué le lot mais la prise de note locale a échoué :
    // rejeu sûr (idempotence `opId` côté central), on n'avance pas.
    scheduler.registerFailure();
    const reason = redactedReason("prise de note du push impossible", error);
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  logger.info(
    `push : ${accepted.length} acceptée(s), ${rejected.length} rejetée(s) sur ${batch.length} (central ${safeOrigin(base)})`,
  );
  return {
    kind: "continue",
    pushed: true,
    accepted: accepted.length,
    rejected: rejected.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 7. Phase pull                                                               */
/* -------------------------------------------------------------------------- */

type PullOutcome =
  | { kind: "continue"; changes: number; applied: number; skipped: number }
  | { kind: "stop"; result: SyncCycleResult };

async function runPull(
  deps: SyncRunnerDeps,
  base: string,
  token: string,
): Promise<PullOutcome> {
  const { logger, scheduler, outbox } = deps;
  const clinicId = deps.clinicId;
  // `clinicId` non nul : garantie par l'étape 3 du cycle.
  if (clinicId === null) {
    return { kind: "stop", result: { status: "needs-clinic" } };
  }

  let cursor: Cursor | null;
  try {
    cursor = await outbox.readCursor();
  } catch (error) {
    scheduler.registerFailure();
    const reason = redactedReason("curseur de pull illisible", error);
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(`${base}/api/sync/pull`, {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify({ clinicId, cursor, limit: DEFAULT_PULL_LIMIT }),
      signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Curseur inchangé : le prochain cycle reprend à la même position (sûr).
    scheduler.registerFailure();
    const reason = redactedReason("pull impossible", error);
    logger.warn(`${reason} — backoff armé`);
    return { kind: "stop", result: { status: "error", reason } };
  }

  if (response.status === 401) {
    deps.token.clear();
    scheduler.registerSuccess();
    logger.warn("pull refusé (HTTP 401) : jeton effacé, ré-authentification requise");
    return { kind: "stop", result: { status: "needs-auth" } };
  }

  if (!response.ok) {
    scheduler.registerFailure();
    const reason = `pull refusé (HTTP ${response.status})`;
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    scheduler.registerFailure();
    const reason = redactedReason("réponse pull illisible", error);
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  const parsed = pullResponseSchema.safeParse(raw);
  if (!parsed.success) {
    // Corps non fiable : aucun curseur écrit (on ne progresse pas sur une
    // donnée qu'on n'a pas pu valider), le prochain cycle re-tire.
    scheduler.registerFailure();
    const reason = "réponse pull non conforme au protocole";
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  const { changes, cursor: nextCursor, hasMore } = parsed.data;

  /* Application locale — chaque erreur y est isolée par `applyPulledChanges`
     (A6) ; seul un rejet **global** (repo hors service) arrive ici. */
  let applied = 0;
  let skipped = 0;
  let applyFailure: unknown = null;
  try {
    const result = await deps.applyChanges(changes);
    applied = result.applied;
    skipped =
      (result.skippedPending ?? 0) +
      (result.skippedUnknown ?? 0) +
      (result.errors?.length ?? 0);
  } catch (error) {
    applyFailure = error;
  }

  /* Curseur : TOUJOURS avancé après une réponse valide, y compris si
     `applyChanges` a rejeté — sinon la ligne fautive bouclerait à chaque
     cycle. Le prix (changements écartés malgré tout) est assumé : les lignes
     restent visibles côté central et la cause est journalisée en `error`. */
  try {
    await outbox.writeCursor(nextCursor);
  } catch (error) {
    scheduler.registerFailure();
    const reason = redactedReason("écriture du curseur impossible", error);
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  if (applyFailure !== null) {
    scheduler.registerFailure();
    const reason = redactedReason(
      "application locale en échec (curseur avancé)",
      applyFailure,
    );
    logger.error(reason);
    return { kind: "stop", result: { status: "error", reason } };
  }

  if (hasMore) {
    logger.info(
      `pull : ${changes.length} changement(s) — page suivante au prochain cycle`,
    );
  }
  return { kind: "continue", changes: changes.length, applied, skipped };
}

/* -------------------------------------------------------------------------- */
/* 8. Cycle complet                                                            */
/* -------------------------------------------------------------------------- */

async function executeCycle(deps: SyncRunnerDeps): Promise<SyncCycleResult> {
  const { baseUrl, clinicId, logger, scheduler, now } = deps;

  /* 1 — aucun central configuré : état nominal, zéro requête, zéro échec. */
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    logger.info(
      "cycle : idle-no-base-url (SYNC_BASE_URL absente — aucune requête réseau)",
    );
    return { status: "idle-no-base-url" };
  }
  const base = baseUrl.replace(/\/+$/, "");

  /* 2 — cadence / backoff : rien n'est consommé. */
  if (!scheduler.shouldRun(now())) {
    return { status: "noop", reason: "backoff" };
  }

  /* 3 — cabinet actif requis avant tout trafic (l'UI le choisit, étape 7). */
  if (clinicId === null || clinicId.trim().length === 0) {
    logger.info(
      "cycle : needs-clinic (aucun cabinet actif — sélection requise, étape 7)",
    );
    return { status: "needs-clinic" };
  }

  /* 4 — disponibilité du central (probe injecté, fail-closed, sans exception). */
  const reachable = await deps.probe.probe(baseUrl);
  if (!reachable) {
    const nextRunAt = scheduler.registerFailure();
    logger.warn(
      `central injoignable (${safeOrigin(baseUrl)}) : backoff jusqu'à ${nextRunAt.toISOString()}`,
    );
    return { status: "offline" };
  }

  /* 5 — habilitation : absent ou expiré → acte utilisateur (étape 7). */
  const stored = deps.token.read();
  const expiresAt =
    stored === null ? Number.NaN : Date.parse(stored.expiresAt);
  if (
    stored === null ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now().getTime()
  ) {
    scheduler.registerSuccess();
    if (stored === null) {
      logger.info(
        "jeton de synchronisation absent : authentification requise (étape 7, jamais automatique)",
      );
    } else {
      logger.warn(
        "jeton de synchronisation expiré : authentification requise (valeur jamais journalisée)",
      );
    }
    return { status: "needs-auth" };
  }

  /* 6 — push de l'outbox. */
  const push = await runPush(deps, base, stored.token);
  if (push.kind === "stop") {
    return push.result;
  }

  /* 7 — pull + application locale + curseur. */
  const pull = await runPull(deps, base, stored.token);
  if (pull.kind === "stop") {
    return pull.result;
  }

  /* 8 — cycle achevé sans erreur. */
  scheduler.registerSuccess();
  if (pull.changes > 0) {
    logger.info(
      `cycle : pull ${pull.applied} appliquée(s), ${pull.skipped} écartée(s) — curseur avancé`,
    );
    return { status: "pulled", applied: pull.applied, skipped: pull.skipped };
  }
  if (push.pushed) {
    return {
      status: "pushed",
      accepted: push.accepted,
      rejected: push.rejected,
    };
  }
  logger.info("cycle : rien à pousser ni à tirer");
  return { status: "noop" };
}

/* -------------------------------------------------------------------------- */
/* 9. Point d'entrée                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exécute **un cycle** de synchronisation. Ne **rejette jamais** : toute
 * défaillance imprévue est convertie en `{ status: "error" }` (motif rédigé) et
 * informe l'ordonnanceur (`registerFailure`) pour armer le backoff.
 *
 * **Mutex** : un second appel concurrent est refusé (`noop` +
 * `reason: "concurrent-cycle"`) avant toute consommation — voir en-tête.
 *
 * @param deps dépendances injectées (aucune création de ressource ici).
 */
export async function runSyncCycle(
  deps: SyncRunnerDeps,
): Promise<SyncCycleResult> {
  if (cycleInFlight) {
    deps.logger.warn(
      "cycle refusé : un cycle est déjà en cours (mutex concurrent-cycle)",
    );
    return { status: "noop", reason: "concurrent-cycle" };
  }
  cycleInFlight = true;
  try {
    return await executeCycle(deps);
  } catch (error) {
    // Filet de sécurité : aucun chemin n'est censé lever, mais un cycle en
    // échec doit toujours armer le backoff plutôt que boucler à vide.
    schedulerFailureSafe(deps);
    const reason = redactedReason("cycle interrompu", error);
    deps.logger.error(reason);
    return { status: "error", reason };
  } finally {
    cycleInFlight = false;
  }
}

/** `registerFailure` tolérant : un ordonnanceur défaissant n'invalide pas le cycle. */
function schedulerFailureSafe(deps: SyncRunnerDeps): void {
  try {
    deps.scheduler.registerFailure();
  } catch {
    // Aucune journalisation ici : le `logger` de l'appelant est déjà alerté.
  }
}
