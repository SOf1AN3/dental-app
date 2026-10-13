import { describe, expect, it } from "vitest";
import {
  MAX_LAST_ERROR_LENGTH,
  MAX_SEND_ATTEMPTS,
  PULL_CURSOR_KEY,
  enqueue,
  enqueueInTransaction,
  markFailed,
  markSent,
  pendingBatch,
  purgeSent,
  readCursor,
  redactError,
  toChangeOp,
  writeCursor,
  type EnqueueParams,
  type NewOutboxRow,
  type OutboxDatabase,
  type OutboxRow,
  type OutboxRepo,
} from "./outbox";
import type { Cursor } from "./protocol";

/* -------------------------------------------------------------------------- */
/* Repo en mémoire — aucune base, aucun réseau (tests hermétiques)             */
/* -------------------------------------------------------------------------- */

interface MemoryStore {
  rows: OutboxRow[];
  state: Map<string, unknown>;
  seq: number;
}

function createStore(): MemoryStore {
  return { rows: [], state: new Map(), seq: 0 };
}

function createMemoryRepo(store: MemoryStore): OutboxRepo {
  return {
    async insertOutbox(row: NewOutboxRow) {
      store.rows.push({
        ...row,
        status: "pending",
        attempts: 0,
        lastError: null,
      });
    },
    async nextSeq() {
      // Miroir du contrat SQL : compteur incrémenté, NOUVELLE valeur renvoyée.
      store.seq += 1;
      return store.seq;
    },
    async listPending(limit: number) {
      return store.rows
        .filter((row) => row.status === "pending")
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },
    async getOutbox(opId: string) {
      return store.rows.find((row) => row.opId === opId) ?? null;
    },
    async markSent(opIds: string[]) {
      const targets = new Set(opIds);
      for (const row of store.rows) {
        if (targets.has(row.opId)) row.status = "sent";
      }
    },
    async updateOutbox(opId, patch) {
      const row = store.rows.find((r) => r.opId === opId);
      if (!row) return;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.lastError !== undefined) row.lastError = patch.lastError;
    },
    async purgeSent(olderThan: Date) {
      const before = store.rows.length;
      store.rows = store.rows.filter(
        (row) => !(row.status === "sent" && row.createdAt < olderThan),
      );
      return before - store.rows.length;
    },
    async setState(key: string, value: unknown) {
      store.state.set(key, value);
    },
    async getState(key: string) {
      return store.state.has(key) ? store.state.get(key) : null;
    },
  };
}

/**
 * DB de test avec transaction réelle (staging) : les écritures d'une tx ne
 * sont visibles dans le store englobant QUE si la tx commit ; sinon rollback.
 * Simule la sémantique Drizzle pour vérifier l'atomicité mutation + outbox.
 */
function createTransactionalDatabase(): {
  db: OutboxDatabase;
  store: MemoryStore;
} {
  const store = createStore();
  const db: OutboxDatabase = {
    async begin() {
      // Staging : copies indépendantes, publiées seulement au commit.
      const staged: MemoryStore = {
        rows: [...store.rows],
        state: new Map(store.state),
        seq: store.seq,
      };
      const repo = createMemoryRepo(staged);
      return {
        repo,
        async rollback() {
          // Rien n'est reporté dans `store` : les écritures staged sont perdues.
        },
        async commit() {
          store.rows = staged.rows;
          store.state = staged.state;
          store.seq = staged.seq;
        },
      };
    },
  };
  return { db, store };
}

function params(overrides: Partial<EnqueueParams> = {}): EnqueueParams {
  return {
    table: "patient",
    rowId: "p1",
    op: "insert",
    payload: { id: "p1", clinicId: "c1", firstName: "Zoé" },
    clinicId: "c1",
    deviceId: "device-1",
    at: new Date("2026-10-13T10:00:00.000Z"),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* enqueue                                                                     */
/* -------------------------------------------------------------------------- */

describe("enqueue", () => {
  it("alloue un seq croissant et unique", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);

    const first = await enqueue(repo, params());
    const second = await enqueue(repo, params({ rowId: "p2" }));
    const third = await enqueue(repo, params({ rowId: "p3" }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    const seqs = store.rows.map((row) => row.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("attribue des opId uuid distincts", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());
    const b = await enqueue(repo, params());
    expect(a.opId).not.toBe(b.opId);
    expect(a.opId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("projette le payload sur la liste blanche (aucun secret stocké)", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await enqueue(
      repo,
      params({
        table: "user",
        rowId: "u1",
        payload: {
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          emailVerified: null,
          image: null,
          tokenVersion: 1,
          passwordHash: "$2b$10$secret",
        },
      }),
    );
    const stored = store.rows[0];
    expect(stored?.payload).not.toHaveProperty("passwordHash");
    expect(stored?.payload).toEqual({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: null,
      image: null,
      tokenVersion: 1,
    });
  });

  it("refuse une table inconnue et n'écrit AUCUNE ligne", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await expect(
      enqueue(repo, params({ table: "account", payload: { userId: "u1" } })),
    ).rejects.toThrow(/absente du registre/);
    expect(store.rows).toHaveLength(0);
  });

  it("stocke les métadonnées (statut pending, attempts 0, horodatage, deviceId)", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await enqueue(repo, params());
    const row = store.rows[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.createdAt).toEqual(new Date("2026-10-13T10:00:00.000Z"));
    expect(row?.deviceId).toBe("device-1");
    expect(row?.clinicId).toBe("c1");
  });
});

/* -------------------------------------------------------------------------- */
/* enqueueInTransaction — atomicité                                            */
/* -------------------------------------------------------------------------- */

describe("enqueueInTransaction", () => {
  it("committe journal ET mutation quand tout réussit", async () => {
    const { db, store } = createTransactionalDatabase();
    const mutated: string[] = [];

    const result = await enqueueInTransaction(db, params(), async () => {
      mutated.push("patient:p1");
    });

    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.seq).toBe(1);
    expect(mutated).toEqual(["patient:p1"]);
    expect(store.rows).toHaveLength(1);
  });

  it("ROLLBACK : un échec APRÈS l'insertion du journal ne laisse AUCUNE ligne", async () => {
    const { db, store } = createTransactionalDatabase();

    await expect(
      enqueueInTransaction(db, params(), async () => {
        // La mutation « réussit » (écrit dans la tx), puis tout s'écroule.
        throw new Error("contrainte violée après journalisation");
      }),
    ).rejects.toThrow(/contrainte violée/);

    // Ni la ligne d'outbox, ni la mutation ne persistent.
    expect(store.rows).toHaveLength(0);
  });

  it("ROLLBACK : une erreur de commit annule également le journal", async () => {
    const store = createStore();
    const failingCommit: OutboxDatabase = {
      async begin() {
        const staged = createStore();
        const repo = createMemoryRepo(staged);
        return {
          repo,
          async rollback() {
            /* staged abandonné */
          },
          async commit() {
            throw new Error("connexion perdue au commit");
          },
        };
      },
    };

    await expect(
      enqueueInTransaction(failingCommit, params(), async () => {
        /* mutation ok */
      }),
    ).rejects.toThrow(/connexion perdue/);
    expect(store.rows).toHaveLength(0);
  });

  it("un rollback ne supprime pas les lignes déjà commitées antérieurement", async () => {
    const { db, store } = createTransactionalDatabase();
    await enqueueInTransaction(db, params({ rowId: "p1" }), async () => {
      /* ok */
    });
    expect(store.rows).toHaveLength(1);

    await expect(
      enqueueInTransaction(db, params({ rowId: "p2" }), async () => {
        throw new Error("échec");
      }),
    ).rejects.toThrow(/échec/);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.rowId).toBe("p1");
  });
});

/* -------------------------------------------------------------------------- */
/* pendingBatch                                                                */
/* -------------------------------------------------------------------------- */

describe("pendingBatch", () => {
  it("retourne les lignes pending par ordre de seq croissant", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await enqueue(repo, params({ rowId: "p1" }));
    await enqueue(repo, params({ rowId: "p2" }));
    await enqueue(repo, params({ rowId: "p3" }));

    const batch = await pendingBatch(repo, 10);
    expect(batch.map((op) => op.rowId)).toEqual(["p1", "p2", "p3"]);
    expect(batch.map((op) => op.updatedAt)).toEqual([
      "2026-10-13T10:00:00.000Z",
      "2026-10-13T10:00:00.000Z",
      "2026-10-13T10:00:00.000Z",
    ]);
  });

  it("respecte la limite du lot", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    for (let i = 1; i <= 5; i += 1) {
      await enqueue(repo, params({ rowId: `p${i}` }));
    }
    const batch = await pendingBatch(repo, 2);
    expect(batch).toHaveLength(2);
    expect(batch.map((op) => op.rowId)).toEqual(["p1", "p2"]);
  });

  it("n'inclut ni les sent ni les failed", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const sent = await enqueue(repo, params({ rowId: "p1" }));
    const failed = await enqueue(repo, params({ rowId: "p2" }));
    await enqueue(repo, params({ rowId: "p3" }));

    await markSent(repo, [sent.opId]);
    await repo.updateOutbox(failed.opId, { status: "failed" });

    const batch = await pendingBatch(repo, 10);
    expect(batch.map((op) => op.rowId)).toEqual(["p3"]);
  });

  it("rejette une limite invalide", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await expect(pendingBatch(repo, 0)).rejects.toThrow(/invalide/);
    await expect(pendingBatch(repo, -1)).rejects.toThrow(/invalide/);
    await expect(pendingBatch(repo, 1.5)).rejects.toThrow(/invalide/);
  });

  it("toChangeOp n'attribue jamais de rev (serveur uniquement)", () => {
    const row: OutboxRow = {
      opId: "op-1",
      table: "patient",
      rowId: "p1",
      op: "update",
      payload: { id: "p1" },
      clinicId: "c1",
      deviceId: "device-1",
      seq: 1,
      createdAt: new Date("2026-10-13T10:00:00.000Z"),
      status: "pending",
      attempts: 0,
      lastError: null,
    };
    const op = toChangeOp(row);
    expect(op).not.toHaveProperty("rev");
    expect(op.deviceId).toBe("device-1");
    // deviceId null → champ omis (pas de `undefined` explicite).
    const opNoDevice = toChangeOp({ ...row, deviceId: null });
    expect(opNoDevice).not.toHaveProperty("deviceId");
  });
});

/* -------------------------------------------------------------------------- */
/* markSent / markFailed                                                       */
/* -------------------------------------------------------------------------- */

describe("markSent", () => {
  it("retire les lignes du lot pending", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params({ rowId: "p1" }));
    const b = await enqueue(repo, params({ rowId: "p2" }));

    await markSent(repo, [a.opId]);

    const batch = await pendingBatch(repo, 10);
    expect(batch.map((op) => op.opId)).toEqual([b.opId]);
    expect(store.rows.find((r) => r.opId === a.opId)?.status).toBe("sent");
  });

  it("est idempotent et accepte un tableau vide", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());

    await markSent(repo, []);
    expect(store.rows[0]?.status).toBe("pending");

    await markSent(repo, [a.opId]);
    await markSent(repo, [a.opId]);
    expect(store.rows[0]?.status).toBe("sent");
  });
});

describe("markFailed", () => {
  it("incrémente attempts et borne lastError", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());

    await markFailed(repo, a.opId, "boom");

    const row = store.rows[0];
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("boom");
    expect(row?.status).toBe("pending"); // rejouable tant que < MAX_SEND_ATTEMPTS
  });

  it("tranche lastError à MAX_LAST_ERROR_LENGTH", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());

    await markFailed(repo, a.opId, "x".repeat(MAX_LAST_ERROR_LENGTH * 2));

    expect(store.rows[0]?.lastError).toHaveLength(MAX_LAST_ERROR_LENGTH);
  });

  it("passe en failed après MAX_SEND_ATTEMPTS échecs", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      await markFailed(repo, a.opId, `échec ${i + 1}`);
    }

    const row = store.rows[0];
    expect(row?.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(row?.status).toBe("failed");
    // Une ligne failed n'apparaît plus dans le lot pending.
    expect(await pendingBatch(repo, 10)).toHaveLength(0);
  });

  it("ne rétrograde jamais une ligne sent et ignore une opId inconnu", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    const a = await enqueue(repo, params());
    await markSent(repo, [a.opId]);

    await markFailed(repo, a.opId, "erreur tardive réseau");
    expect(store.rows[0]?.status).toBe("sent");
    expect(store.rows[0]?.attempts).toBe(0);

    await markFailed(repo, "op-inconnu", "boom");
    expect(store.rows).toHaveLength(1);
  });
});

describe("redactError", () => {
  it("retire les jetons Bearer", () => {
    expect(redactError("401 Authorization Bearer abc.def.ghi")).toBe(
      "401 Authorization Bearer [redacted]",
    );
  });

  it("retire password= et token=", () => {
    const raw = "login failed password=hunter2&token=secret-jwt&ok=1";
    const redacted = redactError(raw);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("secret-jwt");
    expect(redacted).toContain("password=[redacted]");
    expect(redacted).toContain("token=[redacted]");
  });

  it("tranche à MAX_LAST_ERROR_LENGTH", () => {
    expect(redactError("y".repeat(10_000))).toHaveLength(MAX_LAST_ERROR_LENGTH);
  });

  it("conserve une erreur ordinaire intacte", () => {
    expect(redactError("fetch failed: ECONNREFUSED")).toBe(
      "fetch failed: ECONNREFUSED",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* purgeSent                                                                   */
/* -------------------------------------------------------------------------- */

describe("purgeSent", () => {
  it("ne purge QUE les lignes sent, et renvoie le nombre purgé", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);

    const old = await enqueue(repo, params({ rowId: "old", at: new Date("2026-01-01T00:00:00.000Z") }));
    await enqueue(repo, params({ rowId: "pending", at: new Date("2026-01-01T00:00:00.000Z") }));
    const failed = await enqueue(repo, params({ rowId: "failed", at: new Date("2026-01-01T00:00:00.000Z") }));
    const recent = await enqueue(repo, params({ rowId: "recent" }));

    await markSent(repo, [old.opId, recent.opId]);
    await markFailed(repo, failed.opId, "boom");

    const purged = await purgeSent(repo, new Date("2026-06-01T00:00:00.000Z"));

    expect(purged).toBe(1); // seul « old » (sent + ancien) est éligible
    const remaining = store.rows.map((r) => r.rowId).sort();
    expect(remaining).toEqual(["failed", "pending", "recent"]);
  });

  it("renvoie 0 quand rien n'est éligible", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await enqueue(repo, params());
    expect(await purgeSent(repo, new Date("2030-01-01T00:00:00.000Z"))).toBe(0);
    expect(store.rows).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Curseur de pull                                                             */
/* -------------------------------------------------------------------------- */

const CURSOR: Cursor = { updatedAt: "2026-10-13T10:00:00.000Z", id: "p42" };

describe("readCursor / writeCursor", () => {
  it("écris puis lit le curseur idempotemment", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);

    expect(await readCursor(repo)).toBeNull(); // clé absente

    await writeCursor(repo, CURSOR);
    expect(await readCursor(repo)).toEqual(CURSOR);

    // Réécriture à l'identique : sans effet de bord.
    await writeCursor(repo, CURSOR);
    expect(await readCursor(repo)).toEqual(CURSOR);
    expect(store.state.get(PULL_CURSOR_KEY)).toEqual(CURSOR);

    const next: Cursor = { updatedAt: "2026-10-14T08:30:00.000Z", id: "p99" };
    await writeCursor(repo, next);
    expect(await readCursor(repo)).toEqual(next);
  });

  it("retourne null si la valeur stockée est malformée", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await repo.setState(PULL_CURSOR_KEY, { updatedAt: "not-a-date", id: "" });
    expect(await readCursor(repo)).toBeNull();
  });

  it("refuse d'écrire un curseur invalide", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await expect(
      writeCursor(repo, { updatedAt: "nope", id: "" } as unknown as Cursor),
    ).rejects.toThrow();
    expect(store.state.has(PULL_CURSOR_KEY)).toBe(false);
  });

  it("le curseur vit sous la clé last_pull_cursor de sync_state", async () => {
    const store = createStore();
    const repo = createMemoryRepo(store);
    await writeCursor(repo, CURSOR);
    expect([...store.state.keys()]).toEqual([PULL_CURSOR_KEY]);
  });
});
