import { describe, expect, it } from "vitest";
import { createBackoff, SyncScheduler } from "./net";
import type { ConflictEntry } from "./conflict";
import type { ChangeOp, Cursor } from "./protocol";
import { isSyncCycleRunning, runSyncCycle } from "./runner-core";
import type {
  ApplyResultLike,
  SyncLogger,
  SyncOutboxApi,
  SyncRunnerDeps,
  SyncTokenStore,
} from "./runner-core";

/**
 * Tests **hermétiques** de l'orchestrateur de synchronisation — tâche 5.5.
 *
 * Aucun réseau (`fetchImpl` stubbé), aucune base (outbox et curseur en
 * mémoire), aucune horloge réelle (`now` injecté, backoff déterministe sans
 * jitter), aucun `electron-log` (logger capturé en mémoire).
 *
 * Couverture minimale exigée par le plan :
 *  - `idle-no-base-url` sans requête ;
 *  - probe `false` → `offline` + échec enregistré ;
 *  - jeton absent **et** jeton **expiré** → `needs-auth` ;
 *  - push avec `accepted`/`rejected` (marquages + en-tête `Bearer`) ;
 *  - **401 → `token.clear()`** ;
 *  - erreur réseau → `markFailed` sur le lot + backoff (`registerFailure`) ;
 *  - pull → `applyChanges` appelé **puis** `writeCursor`, **même si**
 *    `applyChanges` rejette ;
 *  - mutex : second cycle refusé (`noop` + `concurrent-cycle`) ;
 *  - **aucun message de journal ne contient le jeton** ;
 *  - `conflicts[]` du push → dep optionnelle `recordConflicts` appelée avec les
 *    bonnes entrées, **absente** de la dep → cycle strictement inchangé, et un
 *    échec de la dep n'interrompt jamais le cycle (6.2 / D-4).
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Horloge fixe : les assertions de backoff/expiration sont exactes. */
const T0 = new Date("2026-06-01T12:00:00.000Z");
const DEFAULT_BASE_URL = "https://central.example";
const SECRET_TOKEN = "tok_super_secret_ne_jamais_journalise_0123456789";
const VALID_EXPIRES_AT = "2026-07-01T12:00:00.000Z";
const EXPIRED_EXPIRES_AT = "2026-05-01T12:00:00.000Z";

const PULL_CURSOR: Cursor = {
  updatedAt: "2026-06-01T13:00:00.000Z",
  id: "row-42",
};

function makeOp(index: number): ChangeOp {
  return {
    opId: crypto.randomUUID(),
    table: "patient",
    rowId: `row-${index}`,
    op: "insert",
    payload: {},
    clinicId: "clinic-1",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface HarnessOverrides {
  /** `null` → aucune origine centrale configurée. */
  baseUrl?: string | null;
  clinicId?: string | null;
  probe?: () => Promise<boolean>;
  token?: { token: string; expiresAt: string } | null;
  batch?: ChangeOp[];
  fetchHandler?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  applyChanges?: (ops: ChangeOp[]) => Promise<ApplyResultLike>;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface Harness {
  deps: SyncRunnerDeps;
  overrides: HarnessOverrides;
  logs: string[];
  fetchCalls: FetchCall[];
  probeCalls: (string | undefined)[];
  sent: string[][];
  failed: { opId: string; reason: string }[];
  applyCalls: ChangeOp[][];
  cursorWrites: Cursor[];
  /** Ordre des événements `apply` / `cursor` (contrat « curseur TOUJOURS après »). */
  events: string[];
  tokenCleared: { count: number };
}

function createHarness(overrides: HarnessOverrides = {}): Harness {
  const logs: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const probeCalls: (string | undefined)[] = [];
  const sent: string[][] = [];
  const failed: { opId: string; reason: string }[] = [];
  const applyCalls: ChangeOp[][] = [];
  const cursorWrites: Cursor[] = [];
  const events: string[] = [];
  const tokenCleared = { count: 0 };
  const batch = overrides.batch ?? [];
  let cursor: Cursor | null = null;

  const logger: SyncLogger = {
    info: (message) => {
      logs.push(`info ${message}`);
    },
    warn: (message) => {
      logs.push(`warn ${message}`);
    },
    error: (message) => {
      logs.push(`error ${message}`);
    },
  };

  const scheduler = new SyncScheduler({
    now: () => T0,
    backoff: createBackoff({ jitterRatio: 0 }),
  });

  const outbox: SyncOutboxApi = {
    pendingBatch: async (limit) => batch.slice(0, limit),
    markSent: async (opIds) => {
      sent.push([...opIds]);
    },
    markFailed: async (opId, reason) => {
      failed.push({ opId, reason });
    },
    readCursor: async () => cursor,
    writeCursor: async (next) => {
      cursorWrites.push(next);
      cursor = next;
      events.push("cursor");
    },
  };

  const token: SyncTokenStore = {
    read: () =>
      overrides.token === undefined
        ? { token: SECRET_TOKEN, expiresAt: VALID_EXPIRES_AT }
        : overrides.token,
    write: () => {
      throw new Error("écriture de jeton inattendue dans ces tests");
    },
    clear: () => {
      tokenCleared.count += 1;
    },
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (overrides.fetchHandler !== undefined) {
      return overrides.fetchHandler(url, init);
    }
    if (url.endsWith("/api/sync/push")) {
      return json({
        accepted: batch.map((op) => op.opId),
        rejected: [],
        conflicts: [],
      });
    }
    if (url.endsWith("/api/sync/pull")) {
      return json({ changes: [], cursor: PULL_CURSOR, hasMore: false });
    }
    throw new Error(`URL inattendue : ${url}`);
  };

  const applyChanges = async (ops: ChangeOp[]): Promise<ApplyResultLike> => {
    applyCalls.push(ops);
    events.push("apply");
    if (overrides.applyChanges !== undefined) {
      return overrides.applyChanges(ops);
    }
    return {
      applied: ops.length,
      skippedPending: 0,
      skippedUnknown: 0,
      errors: [],
    };
  };

  const deps: SyncRunnerDeps = {
    baseUrl:
      overrides.baseUrl === undefined
        ? DEFAULT_BASE_URL
        : (overrides.baseUrl ?? undefined),
    clinicId: overrides.clinicId === undefined ? "clinic-1" : overrides.clinicId,
    deviceId: "device-1",
    probe: {
      probe: async (baseUrl) => {
        probeCalls.push(baseUrl);
        if (overrides.probe !== undefined) {
          return overrides.probe();
        }
        return true;
      },
    },
    scheduler,
    outbox,
    token,
    applyChanges,
    fetchImpl,
    now: () => T0,
    logger,
  };

  return {
    deps,
    overrides,
    logs,
    fetchCalls,
    probeCalls,
    sent,
    failed,
    applyCalls,
    cursorWrites,
    events,
    tokenCleared,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("runSyncCycle — garde-fous", () => {
  it("sans baseUrl : idle-no-base-url, zéro requête réseau, aucun échec enregistré", async () => {
    const harness = createHarness({ baseUrl: null });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "idle-no-base-url" });
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(0);
    expect(harness.deps.scheduler.state).toBe("unknown");
  });

  it("backoff actif (shouldRun faux) : noop immédiat, rien n'est consommé", async () => {
    const harness = createHarness();
    harness.deps.scheduler.registerFailure();

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "noop", reason: "backoff" });
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(1);
  });

  it("sans cabinet actif : needs-clinic avant tout trafic", async () => {
    const harness = createHarness({ clinicId: null });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "needs-clinic" });
    expect(harness.probeCalls).toHaveLength(0);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(0);
  });

  it("probe false : offline + registerFailure (backoff armé)", async () => {
    const harness = createHarness({ probe: () => Promise.resolve(false) });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "offline" });
    expect(harness.probeCalls).toEqual([DEFAULT_BASE_URL]);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(1);
    expect(harness.deps.scheduler.state).toBe("offline");
  });
});

describe("runSyncCycle — habilitation", () => {
  it("jeton absent : needs-auth, registerSuccess, aucune requête push/pull", async () => {
    const harness = createHarness({ token: null });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "needs-auth" });
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.tokenCleared.count).toBe(0);
    // L'auth n'est pas un échec réseau : le backoff est réinitialisé.
    expect(harness.deps.scheduler.attempt).toBe(0);
    expect(harness.deps.scheduler.state).toBe("online");
  });

  it("jeton EXPIRÉ (expiresAt ≤ now) : needs-auth sans toucher au réseau", async () => {
    const harness = createHarness({
      token: { token: SECRET_TOKEN, expiresAt: EXPIRED_EXPIRES_AT },
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "needs-auth" });
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.deps.scheduler.state).toBe("online");
  });

  it("push 401 : clear() du jeton + needs-auth (aucun marquage d'outbox)", async () => {
    const ops = [makeOp(1), makeOp(2)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: () => json({ error: "unauthorized" }, 401),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "needs-auth" });
    expect(harness.tokenCleared.count).toBe(1);
    expect(harness.sent).toHaveLength(0);
    expect(harness.failed).toHaveLength(0);
    // Le serveur est joignable : l'auth perdue n'arme pas le backoff réseau.
    expect(harness.deps.scheduler.attempt).toBe(0);
    expect(harness.cursorWrites).toHaveLength(0);
  });

  it("pull 401 : clear() du jeton + needs-auth, curseur inchangé", async () => {
    const harness = createHarness({
      fetchHandler: () => json({ error: "unauthorized" }, 401),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "needs-auth" });
    expect(harness.tokenCleared.count).toBe(1);
    expect(harness.cursorWrites).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(0);
  });

  it("aucun message de journal ne contient le jeton (succès puis 401)", async () => {
    const ops = [makeOp(1)];
    const harness = createHarness({ batch: ops });

    const success = await runSyncCycle(harness.deps);
    // Second cycle : même jeton, réponse 401 (chemin le plus bavard).
    harness.overrides.fetchHandler = () => json({ error: "unauthorized" }, 401);
    const unauthorized = await runSyncCycle(harness.deps);

    expect(success.status === "pushed" || success.status === "pulled").toBe(true);
    expect(unauthorized).toEqual({ status: "needs-auth" });
    expect(harness.logs.length).toBeGreaterThan(0);
    for (const line of harness.logs) {
      expect(line).not.toContain(SECRET_TOKEN);
    }
    expect(JSON.stringify(unauthorized)).not.toContain(SECRET_TOKEN);
    // … mais le jeton est bien porté par l'en-tête `Authorization`.
    const pushCall = harness.fetchCalls[0];
    expect(pushCall.init?.headers).toMatchObject({
      Authorization: `Bearer ${SECRET_TOKEN}`,
    });
  });
});

describe("runSyncCycle — push", () => {
  it("accepted → markSent, rejected → markFailed(reason), puis tirage vide → pushed", async () => {
    const ops = [makeOp(1), makeOp(2), makeOp(3)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: (url) => {
        if (url.endsWith("/api/sync/push")) {
          return json({
            accepted: [ops[0].opId],
            rejected: [
              { opId: ops[1].opId, reason: "ligne verrouillée" },
              { opId: ops[2].opId, reason: "conflit LWW" },
            ],
            conflicts: [],
          });
        }
        return json({ changes: [], cursor: PULL_CURSOR, hasMore: false });
      },
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "pushed", accepted: 1, rejected: 2 });
    expect(harness.sent).toEqual([[ops[0].opId]]);
    expect(harness.failed.map((entry) => entry.opId)).toEqual([
      ops[1].opId,
      ops[2].opId,
    ]);
    expect(harness.failed.map((entry) => entry.reason)).toEqual([
      "ligne verrouillée",
      "conflit LWW",
    ]);
    // Contrat de la requête : en-tête porteur + corps validé.
    const pushCall = harness.fetchCalls.find((call) =>
      call.url.endsWith("/api/sync/push"),
    );
    expect(pushCall).toBeDefined();
    expect(pushCall?.init?.headers).toMatchObject({
      Authorization: `Bearer ${SECRET_TOKEN}`,
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(pushCall?.init?.body)) as {
      deviceId: string;
      clinicId: string;
      ops: ChangeOp[];
    };
    expect(body.deviceId).toBe("device-1");
    expect(body.clinicId).toBe("clinic-1");
    expect(body.ops).toHaveLength(3);
    // Le cycle poursuit son tirage même après un lot partiellement rejeté.
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
    expect(harness.deps.scheduler.state).toBe("online");
  });

  it("erreur réseau sur le push : markFailed sur TOUT le lot + registerFailure", async () => {
    const ops = [makeOp(1), makeOp(2)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: () => Promise.reject(new TypeError("fetch failed")),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toContain("push impossible");
      expect(result.reason).not.toContain(SECRET_TOKEN);
    }
    expect(harness.failed.map((entry) => entry.opId)).toEqual([
      ops[0].opId,
      ops[1].opId,
    ]);
    expect(harness.sent).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(1);
    expect(harness.cursorWrites).toHaveLength(0);
  });
});

describe("runSyncCycle — pull", () => {
  it("applyChanges appelé avec les changements PUIS writeCursor (curseur avancé)", async () => {
    const changes = [makeOp(10), makeOp(11)];
    const harness = createHarness({
      fetchHandler: (url) => {
        if (url.endsWith("/api/sync/push")) {
          return json({ accepted: [], rejected: [], conflicts: [] });
        }
        return json({ changes, cursor: PULL_CURSOR, hasMore: false });
      },
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "pulled", applied: 2, skipped: 0 });
    expect(harness.applyCalls).toEqual([changes]);
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
    expect(harness.events).toEqual(["apply", "cursor"]);
    // Le curseur repart du pilote : relecture identique.
    await expect(harness.deps.outbox.readCursor()).resolves.toEqual(PULL_CURSOR);
  });

  it("applyChanges REJETTE : writeCursor est quand même appelé (ligne empoisonnée non bouclante)", async () => {
    const changes = [makeOp(20)];
    const harness = createHarness({
      fetchHandler: (url) => {
        if (url.endsWith("/api/sync/push")) {
          return json({ accepted: [], rejected: [], conflicts: [] });
        }
        return json({ changes, cursor: PULL_CURSOR, hasMore: false });
      },
      applyChanges: () => Promise.reject(new Error("repo hors service")),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toContain("application locale");
    }
    expect(harness.applyCalls).toEqual([changes]);
    // Le curseur avance MALGRE l'échec : la ligne ne bouclera pas.
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
    expect(harness.events).toEqual(["apply", "cursor"]);
    expect(harness.deps.scheduler.attempt).toBe(1);
  });

  it("réponse pull non conforme : error + registerFailure, AUCUNE écriture de curseur", async () => {
    const harness = createHarness({
      fetchHandler: (url) => {
        if (url.endsWith("/api/sync/push")) {
          return json({ accepted: [], rejected: [], conflicts: [] });
        }
        return json({ changes: "pas-un-tableau" });
      },
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({
      status: "error",
      reason: "réponse pull non conforme au protocole",
    });
    expect(harness.cursorWrites).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.deps.scheduler.attempt).toBe(1);
  });

  it("tout est synchronisé : rien à pousser ni à tirer → noop", async () => {
    const harness = createHarness({
      fetchHandler: () => json({ changes: [], cursor: PULL_CURSOR, hasMore: false }),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "noop" });
    expect(harness.deps.scheduler.state).toBe("online");
    // Un tirage a malgré tout eu lieu : le curseur reste validé.
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
  });
});

describe("runSyncCycle — mutex", () => {
  it("refuse un second cycle concurrent (noop concurrent-cycle) puis relâche le verrou", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      probe: () => gate.then(() => true),
    });

    const first = runSyncCycle(harness.deps);
    const second = await runSyncCycle(harness.deps);

    expect(second).toEqual({ status: "noop", reason: "concurrent-cycle" });
    expect(isSyncCycleRunning()).toBe(true);
    // Le refus n'a rien consommé : aucune seconde tentative réseau.
    expect(harness.fetchCalls).toHaveLength(0);

    release?.();
    const firstResult = await first;
    expect(firstResult.status).toBe("noop");
    expect(isSyncCycleRunning()).toBe(false);

    // Le verrou est bien relâché : un cycle suivant repart.
    const third = await runSyncCycle(harness.deps);
    expect(third.status === "noop" || third.status === "pulled").toBe(true);
    expect(isSyncCycleRunning()).toBe(false);
  });
});

describe("runSyncCycle — journal des conflits du push (D-4, tâche 6.2)", () => {
  /** Réponse de push portant des `conflicts[]` + tirage vide (cycle `pushed`). */
  function pushWithConflicts(ops: ChangeOp[]) {
    return (url: string): Response => {
      if (url.endsWith("/api/sync/push")) {
        return json({
          accepted: ops.map((op) => op.opId),
          rejected: [],
          conflicts: [
            { table: "patient", rowId: "p-9", reason: "base-rev-mismatch" },
            { table: "invoice", rowId: "i-3", reason: "protected-amounts" },
          ],
        });
      }
      return json({ changes: [], cursor: PULL_CURSOR, hasMore: false });
    };
  }

  it("conflicts renvoyés → `recordConflicts` appelé avec les bonnes entrées", async () => {
    const ops = [makeOp(1)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: pushWithConflicts(ops),
    });
    const recorded: ConflictEntry[][] = [];
    harness.deps.recordConflicts = async (entries) => {
      recorded.push(entries);
    };

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "pushed", accepted: 1, rejected: 0 });
    // Triples `(table, rowId, reason)` seuls : aucun payload ne quitte le cœur.
    expect(recorded).toEqual([
      [
        { table: "patient", rowId: "p-9", reason: "base-rev-mismatch" },
        { table: "invoice", rowId: "i-3", reason: "protected-amounts" },
      ],
    ]);
    expect(harness.logs.some((line) => line.includes("journal local alimenté"))).toBe(true);
    // Le sort des opérations reste prioritaire : marquages inchangés.
    expect(harness.sent).toEqual([[ops[0].opId]]);
    expect(harness.failed).toHaveLength(0);
  });

  it("dep ABSENTE → cycle strictement inchangé (conflits comptés, jamais persistés)", async () => {
    const ops = [makeOp(1)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: pushWithConflicts(ops),
    });

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "pushed", accepted: 1, rejected: 0 });
    expect(harness.deps.recordConflicts).toBeUndefined();
    expect(harness.logs.some((line) => line.includes("journal local non alimenté"))).toBe(true);
    // Aucune erreur : l'absence de dep n'est pas une défaillance.
    expect(harness.logs.filter((line) => line.startsWith("error"))).toHaveLength(0);
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
    expect(harness.deps.scheduler.state).toBe("online");
  });

  it("dep en échec → le cycle se poursuit (journal best-effort, erreur bornée)", async () => {
    const ops = [makeOp(1)];
    const harness = createHarness({
      batch: ops,
      fetchHandler: pushWithConflicts(ops),
    });
    harness.deps.recordConflicts = () => Promise.reject(new Error("repo hors service"));

    const result = await runSyncCycle(harness.deps);

    expect(result).toEqual({ status: "pushed", accepted: 1, rejected: 0 });
    const errors = harness.logs.filter((line) => line.startsWith("error"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("journalisation des conflits impossible");
    expect(errors[0]).toContain("repo hors service");
    // Le tirage a eu lieu malgré tout : la trace n'est jamais bloquante.
    expect(harness.cursorWrites).toEqual([PULL_CURSOR]);
    expect(harness.deps.scheduler.state).toBe("online");
  });

  it("aucun conflit → `recordConflicts` n'est même pas appelé", async () => {
    const ops = [makeOp(1)];
    const harness = createHarness({ batch: ops });
    let calls = 0;
    harness.deps.recordConflicts = async () => {
      calls += 1;
    };

    const result = await runSyncCycle(harness.deps);

    expect(result.status === "pushed" || result.status === "pulled").toBe(true);
    expect(calls).toBe(0);
  });
});
