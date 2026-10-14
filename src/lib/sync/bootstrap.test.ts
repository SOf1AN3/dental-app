import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyncBootstrapHandler,
  extractUserPasswordHashes,
  MAX_BOOTSTRAP_PAGES,
  MAX_BOOTSTRAP_ROWS,
  type BootstrapCentralEnv,
  type SyncBootstrapHandlerDeps,
  type UserPasswordHashWrite,
} from "@/app/api/sync/bootstrap/route";
import {
  applyPulledChanges,
  type LocalApplyRepo,
  type LocalApplyTx,
  type Row,
} from "@/lib/sync/local-apply";
import type { ChangeOp, Cursor, PullResponse } from "@/lib/sync/protocol";

/**
 * Tests **hermétiques** de `POST /api/sync/bootstrap` (tâche 7.1) :
 * aucun serveur, aucune base, aucun réseau — les deps de la fabrique de handler
 * (`readEnv`, `fetchImpl`, `createRepo`, `isRowLocallyPending`,
 * `writeUserPasswordHashes`, `now`) sont injectées.
 *
 * Points verrouillés :
 *  1. 409 `not-authenticated` sans env de jeton (avant tout appel réseau) ;
 *  2. validation du corps (au moins un cabinet) ;
 *  3. plafonds de pages **et** d'opérations respectés ;
 *  4. `applyPulledChanges` reçoit un `isRowLocallyPending` **réellement
 *     appelé** (garde A1 : la ligne en attente n'est jamais écrasée) ;
 *  5. défaillance réseau → 500 générique, sans fuite de jeton dans les journaux ;
 *  6. `password_hash` : **écrit** par le chemin bootstrap (porte dédiée) et
 *     **absent** du chemin de pull normal (projection `serializeRow`).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ENV: BootstrapCentralEnv = {
  token: "jeton-appareil-ultra-secret",
  baseUrl: "https://central.example.test",
  deviceId: "device-1",
};

/** Hash bcrypt réel (bcryptjs) — la regex de la route doit l'accepter. */
const BCRYPT_HASH = bcrypt.hashSync("mot-de-passe-secret", 4);

const CLINIC = "clinic-1";

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/sync/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeOp(partial: {
  table: string;
  rowId?: string;
  op?: ChangeOp["op"];
  payload?: Record<string, unknown>;
  clinicId?: string | null;
}): ChangeOp {
  return {
    opId: crypto.randomUUID(),
    table: partial.table,
    rowId: partial.rowId ?? crypto.randomUUID(),
    op: partial.op ?? "insert",
    payload: partial.payload ?? {},
    clinicId: partial.clinicId ?? CLINIC,
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

function makePage(changes: ChangeOp[], hasMore: boolean, cursorId: string): PullResponse {
  return {
    changes,
    cursor: { updatedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(), id: cursorId },
    hasMore,
  };
}

/** Repo mémoire : mêmes contrats que `LocalApplyRepo` (aucune base). */
interface MemoryRepo {
  readonly repo: LocalApplyRepo;
  readonly rows: Map<string, Row>;
}

function createMemoryRepo(): MemoryRepo {
  const rows = new Map<string, Row>();
  const repo: LocalApplyRepo = {
    async transaction<T>(fn: (tx: LocalApplyTx) => Promise<T>): Promise<T> {
      return fn({
        async upsertRow(table, rowId, insert, update) {
          const key = `${table}:${rowId}`;
          const existing = rows.get(key);
          rows.set(key, existing === undefined ? { ...insert } : { ...existing, ...update });
        },
      });
    },
  };
  return { repo, rows };
}

interface FetchCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

/** Stub `fetch` : répond la page produite par `respond(index)`, trace les appels. */
function createFetchStub(
  respond: (callIndex: number) => PullResponse,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization"), body });
    return new Response(JSON.stringify(respond(calls.length - 1)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

/** Deps par défaut : env valide, aucun réseau attendu, repo mémoire injectable. */
function baseDeps(overrides: Partial<SyncBootstrapHandlerDeps> = {}): SyncBootstrapHandlerDeps {
  return {
    readEnv: () => ENV,
    fetchImpl: async () => {
      throw new Error("aucun appel réseau attendu");
    },
    createRepo: () => createMemoryRepo().repo,
    isRowLocallyPending: async () => false,
    writeUserPasswordHashes: async () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function captureLogs(): () => string {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () =>
    [...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((value) => String(value))
      .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 1. Authentification d'environnement                                         */
/* -------------------------------------------------------------------------- */

describe("POST /api/sync/bootstrap — env absent", () => {
  it("répond 409 not-authenticated SANS appel réseau, avec message « connectez-vous d'abord »", async () => {
    let fetchCount = 0;
    const handler = createSyncBootstrapHandler(
      baseDeps({
        readEnv: () => null,
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("réseau inattendu");
        },
      }),
    );

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("not-authenticated");
    expect(body.message).toMatch(/connectez-vous d'abord/i);
    expect(fetchCount).toBe(0);
  });

  it("env incomplet (jeton vide) → aussi 409", async () => {
    const handler = createSyncBootstrapHandler(
      baseDeps({ readEnv: () => ({ ...ENV, token: "   " }) }),
    );
    const res = await handler(postJson({ clinicIds: [CLINIC] }));
    expect(res.status).toBe(409);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Validation du corps                                                      */
/* -------------------------------------------------------------------------- */

describe("POST /api/sync/bootstrap — corps", () => {
  it("400 invalid-request si aucun cabinet n'est fourni", async () => {
    const handler = createSyncBootstrapHandler(baseDeps());
    for (const body of [{}, { clinicIds: [] }, { clinicIds: [""] }]) {
      const res = await handler(postJson(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid-request");
    }
  });

  it("accepte la forme singulière `clinicId` et tire une page unique", async () => {
    const { fetchImpl, calls } = createFetchStub(() => makePage([], false, "c-1"));
    const handler = createSyncBootstrapHandler(baseDeps({ fetchImpl }));

    const res = await handler(postJson({ clinicId: CLINIC }));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.clinicId).toBe(CLINIC);
    expect(calls[0].body.cursor).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Plafonds                                                                  */
/* -------------------------------------------------------------------------- */

describe("POST /api/sync/bootstrap — plafonds", () => {
  it("s'arrête à MAX_BOOTSTRAP_PAGES pages et signale hasMore", async () => {
    const { fetchImpl, calls } = createFetchStub((index) => makePage([], true, `cursor-${index}`));
    const handler = createSyncBootstrapHandler(baseDeps({ fetchImpl }));

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pulled: number; hasMore: boolean; cursor: Cursor | null };
    expect(calls).toHaveLength(MAX_BOOTSTRAP_PAGES);
    expect(body.hasMore).toBe(true);
    expect(body.pulled).toBe(0);
    expect(body.cursor?.id).toBe(`cursor-${MAX_BOOTSTRAP_PAGES - 1}`);
  });

  it("s'arrête à MAX_BOOTSTRAP_ROWS opérations et signale hasMore", async () => {
    const pageChanges = MAX_BOOTSTRAP_ROWS / 10; // 10 pages de 500 opérations
    const { fetchImpl, calls } = createFetchStub((index) =>
      makePage(
        Array.from({ length: pageChanges }, () => makeOp({ table: "patient" })),
        true,
        `cursor-${index}`,
      ),
    );
    const handler = createSyncBootstrapHandler(baseDeps({ fetchImpl }));

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pulled: number; hasMore: boolean };
    expect(body.pulled).toBe(MAX_BOOTSTRAP_ROWS);
    expect(body.hasMore).toBe(true);
    expect(calls).toHaveLength(10);
  });

  it("hasMore=false quand toutes les pages ont été consommées", async () => {
    const { fetchImpl, calls } = createFetchStub((index) =>
      makePage(
        index === 0 ? [makeOp({ table: "patient" })] : [],
        index === 0,
        `cursor-${index}`,
      ),
    );
    const handler = createSyncBootstrapHandler(baseDeps({ fetchImpl }));

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pulled: number; hasMore: boolean };
    expect(calls).toHaveLength(2);
    expect(body).toEqual({ pulled: 1, hasMore: false, cursor: expect.anything() });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. applyPulledChanges + isRowLocallyPending (garde A1)                       */
/* -------------------------------------------------------------------------- */

describe("POST /api/sync/bootstrap — application locale", () => {
  it("transmet isRowLocallyPending à applyPulledChanges, qui IGNORE la ligne en attente", async () => {
    const { repo, rows } = createMemoryRepo();
    const pendingRowId = "patient-en-attente";
    const freshRowId = "patient-frais";
    const seen: Array<{ table: string; rowId: string }> = [];

    const changes = [
      makeOp({ table: "patient", rowId: pendingRowId }),
      makeOp({ table: "patient", rowId: freshRowId }),
    ];
    const { fetchImpl } = createFetchStub(() => makePage(changes, false, "c-1"));

    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl,
        createRepo: () => repo,
        isRowLocallyPending: async (table, rowId) => {
          seen.push({ table, rowId });
          return rowId === pendingRowId;
        },
      }),
    );

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    // Le garde-fou est appelé, opération par opération, avec les bons arguments.
    expect(seen).toEqual([
      { table: "patient", rowId: pendingRowId },
      { table: "patient", rowId: freshRowId },
    ]);
    // A1 : la ligne « pending » n'est JAMAIS écrasée, l'autre est appliquée.
    expect(rows.has(`patient:${pendingRowId}`)).toBe(false);
    const applied = rows.get(`patient:${freshRowId}`);
    expect(applied).toBeDefined();
    // `updated_at` appliqué = horodatage SERVEUR (colonnes de curseur) —
    // `coerceRow` convertit l'ISO reçu en `Date` pour la colonne `timestamp`.
    expect(applied?.updatedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("en-tête Authorization + curseur paginé transmis au central", async () => {
    const { fetchImpl, calls } = createFetchStub((index) =>
      makePage(index === 0 ? [makeOp({ table: "patient" })] : [], index === 0, `cursor-${index}`),
    );
    const handler = createSyncBootstrapHandler(baseDeps({ fetchImpl }));

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${ENV.baseUrl}/api/sync/pull`);
    expect(calls[0].authorization).toBe(`Bearer ${ENV.token}`);
    expect(calls[1].body.cursor).toEqual({
      updatedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(),
      id: "cursor-0",
    });
    // Réponse : aucun secret.
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(ENV.token);
    expect(text).not.toContain(ENV.deviceId);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Défaillance réseau                                                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/sync/bootstrap — erreurs", () => {
  it("erreur réseau → 500 internal-error générique, sans fuite de jeton", async () => {
    const logged = captureLogs();
    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl: async () => {
          throw new TypeError("connect ECONNREFUSED 127.0.0.1:5432");
        },
      }),
    );

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(500);
    // Réponse strictement générique : aucun détail interne.
    expect(await res.json()).toEqual({ error: "internal-error" });
    expect(logged()).not.toContain(ENV.token);
  });

  it("réponse centrale malformée → 500 générique", async () => {
    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl: async () =>
          new Response(JSON.stringify({ surprise: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    );
    const res = await handler(postJson({ clinicIds: [CLINIC] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal-error" });
  });

  it("HTTP 401 du central → 500 générique (aucun oracle)", async () => {
    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      }),
    );
    const res = await handler(postJson({ clinicIds: [CLINIC] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal-error" });
  });
});

/* -------------------------------------------------------------------------- */
/* 6. password_hash — porte dédiée bootstrap VS pull normal                     */
/* -------------------------------------------------------------------------- */

describe("password_hash", () => {
  it("hash réel accepté par la regex d'extraction (auto-vérification)", () => {
    expect(BCRYPT_HASH).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(extractUserPasswordHashes([makeOp({ table: "user", payload: { passwordHash: BCRYPT_HASH } })])
      .map((write) => write.hash)).toEqual([BCRYPT_HASH]);
  });

  it("bootstrap : le hash tiré est écrit via la porte dédiée, JAMAIS via applyPulledChanges", async () => {
    const logged = captureLogs();
    const { repo, rows } = createMemoryRepo();
    const writes: UserPasswordHashWrite[] = [];
    const userId = "user-1";
    const changes = [
      makeOp({
        table: "user",
        rowId: userId,
        payload: {
          email: "ada@example.dz",
          name: "Ada",
          passwordHash: BCRYPT_HASH,
        },
      }),
    ];
    const { fetchImpl } = createFetchStub(() => makePage(changes, false, "c-1"));

    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl,
        createRepo: () => repo,
        writeUserPasswordHashes: async (items) => {
          writes.push(...items);
        },
      }),
    );

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    // Porte dédiée : UN write, pour le bon utilisateur.
    expect(writes).toEqual([{ userId, hash: BCRYPT_HASH }]);
    // ... mais l'application commune (A2) n'a JAMAIS écrit la colonne.
    const applied = rows.get(`user:${userId}`);
    expect(applied).toBeDefined();
    expect(applied).not.toHaveProperty("passwordHash");
    expect(applied).not.toHaveProperty("password_hash");
    // Ni le hash ni le jeton ne figurent dans les journaux.
    expect(logged()).not.toContain(BCRYPT_HASH);
    expect(logged()).not.toContain(ENV.token);
  });

  it("pull normal (applyPulledChanges seul) : password_hash ABSENT de la ligne écrite", async () => {
    const { repo, rows } = createMemoryRepo();
    const op = makeOp({
      table: "user",
      rowId: "user-2",
      payload: { email: "bob@example.dz", passwordHash: BCRYPT_HASH, password_hash: BCRYPT_HASH },
    });

    const result = await applyPulledChanges(repo, [op], {
      isRowLocallyPending: async () => false,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.applied).toBe(1);
    const row = rows.get("user:user-2");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("password_hash");
    expect(row?.email).toBe("bob@example.dz");
  });

  it("valeur non-bcrypt refusée : aucune écriture (le profil reste appliqué)", async () => {
    const { repo, rows } = createMemoryRepo();
    const writes: UserPasswordHashWrite[] = [];
    const changes = [
      makeOp({
        table: "user",
        rowId: "user-3",
        payload: { email: "eve@example.dz", passwordHash: "azerty" },
      }),
    ];
    const { fetchImpl } = createFetchStub(() => makePage(changes, false, "c-1"));
    const handler = createSyncBootstrapHandler(
      baseDeps({
        fetchImpl,
        createRepo: () => repo,
        writeUserPasswordHashes: async (items) => {
          writes.push(...items);
        },
      }),
    );

    const res = await handler(postJson({ clinicIds: [CLINIC] }));

    expect(res.status).toBe(200);
    expect(writes).toEqual([]);
    expect(rows.get("user:user-3")).toBeDefined();
  });

  it("extract : table non-`user`, op `delete` et doublons ignorés", () => {
    const writes = extractUserPasswordHashes([
      makeOp({ table: "clinic", payload: { passwordHash: BCRYPT_HASH } }),
      makeOp({ table: "user", rowId: "u-9", op: "delete", payload: { passwordHash: BCRYPT_HASH } }),
      makeOp({ table: "user", rowId: "u-1", payload: { password_hash: BCRYPT_HASH } }),
      makeOp({ table: "user", rowId: "u-1", payload: { passwordHash: BCRYPT_HASH } }),
      makeOp({ table: "user", rowId: "u-2", payload: { passwordHash: "n'importe-quoi" } }),
    ]);
    expect(writes).toEqual([{ userId: "u-1", hash: BCRYPT_HASH }]);
  });
});
