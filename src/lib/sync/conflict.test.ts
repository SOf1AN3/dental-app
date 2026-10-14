import { describe, expect, it } from "vitest";
import {
  CONFLICT_DEDUPE_WINDOW_MS,
  journalConflict,
  listConflicts,
  recordPushConflicts,
  resolveConflict,
  sanitizeConflictReason,
  type ConflictEntry,
  type ConflictFilter,
  type ConflictRepo,
  type ConflictRow,
  type NewConflictRow,
} from "./conflict";

/**
 * Tests **hermétiques** du journal local des conflits (D-4) — tâche 6.2.
 *
 * Repo mémoire, horloge injectée. Couverture exigée :
 *  - `recordPushConflicts` : **idempotent** (clé
 *    `(table, rowId, deviceId, decided_at` tronqué`)`, payloads **projetés**
 *    (`password_hash` disparaît) et **aucun secret** stocké ;
 *  - lecture (`listConflicts`) et clôture (`resolveConflict`) de la revue.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = new Date("2026-06-01T12:00:00.000Z");
const LATER = new Date(T0.getTime() + 2 * CONFLICT_DEDUPE_WINDOW_MS);

function makeEntry(overrides: Partial<ConflictEntry> = {}): ConflictEntry {
  return {
    table: "patient",
    rowId: "row-1",
    reason: "base-rev-mismatch",
    ...overrides,
  };
}

function createMemoryRepo(): ConflictRepo & { rows: ConflictRow[] } {
  const rows: ConflictRow[] = [];
  const matches = (row: ConflictRow, filter: ConflictFilter): boolean => {
    if (filter.table !== undefined && row.table !== filter.table) return false;
    if (filter.rowId !== undefined && row.rowId !== filter.rowId) return false;
    if (filter.deviceId !== undefined && row.deviceId !== filter.deviceId) return false;
    if (filter.unresolvedOnly === true && row.resolvedAt !== null) return false;
    if (filter.reasonPrefix !== undefined && !(row.reason ?? "").startsWith(filter.reasonPrefix)) {
      return false;
    }
    return true;
  };

  const repo: ConflictRepo & { rows: ConflictRow[] } = {
    rows,
    async findRecent(table, rowId, limit = 50) {
      return rows
        .filter((row) => row.table === table && row.rowId === rowId)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async insert(row: NewConflictRow) {
      rows.push({
        id: row.id ?? crypto.randomUUID(),
        table: row.table,
        rowId: row.rowId,
        deviceId: row.deviceId,
        winning: row.winning,
        losing: row.losing,
        reason: row.reason,
        decidedAt: row.decidedAt,
        resolvedBy: null,
        resolvedAt: null,
      });
    },
    async list(filter) {
      return rows
        .filter((row) => matches(row, filter))
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
        .slice(0, filter.limit ?? 200)
        .map((row) => ({ ...row }));
    },
    async resolve(id, resolvedBy, at) {
      const row = rows.find((entry) => entry.id === id);
      if (row === undefined || row.resolvedAt !== null) return;
      row.resolvedBy = resolvedBy;
      row.resolvedAt = at;
    },
  };
  return repo;
}

/* -------------------------------------------------------------------------- */
/* 1. recordPushConflicts — écriture + idempotence                             */
/* -------------------------------------------------------------------------- */

describe("recordPushConflicts — journalisation du push (D-4)", () => {
  it("insère chaque conflit et renvoie le nombre de lignes ajoutées", async () => {
    const repo = createMemoryRepo();

    const inserted = await recordPushConflicts(
      repo,
      [
        { table: "patient", rowId: "p-1", reason: "base-rev-mismatch" },
        { table: "invoice", rowId: "i-1", reason: "protected-amounts" },
      ],
      T0,
    );

    expect(inserted).toBe(2);
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows.map((row) => row.table)).toEqual(["patient", "invoice"]);
    expect(repo.rows[0]).toMatchObject({
      table: "patient",
      rowId: "p-1",
      reason: "base-rev-mismatch",
      decidedAt: T0,
      deviceId: null,
      resolvedAt: null,
    });
  });

  it("idempotent : la même réponse de push rejouée dans la même minute n'ajoute rien", async () => {
    const repo = createMemoryRepo();
    const entries: ConflictEntry[] = [
      { table: "patient", rowId: "p-1", reason: "base-rev-mismatch" },
      { table: "patient", rowId: "p-2", reason: "protected-amounts" },
    ];

    const first = await recordPushConflicts(repo, entries, T0);
    const replay = await recordPushConflicts(repo, entries, T0);
    // …y compris quelques secondes plus tard (même `bucket` de `decided_at`).
    const sameWindow = await recordPushConflicts(
      repo,
      entries,
      new Date(T0.getTime() + 45_000),
    );

    expect(first).toBe(2);
    expect(replay).toBe(0);
    expect(sameWindow).toBe(0);
    expect(repo.rows).toHaveLength(2);
  });

  it("fenêtre suivante : un nouvel arbitrage est à nouveau journalisé", async () => {
    const repo = createMemoryRepo();

    await recordPushConflicts(repo, [makeEntry()], T0);
    const later = await recordPushConflicts(repo, [makeEntry()], LATER);

    expect(later).toBe(1);
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows.map((row) => row.decidedAt)).toEqual([T0, LATER]);
  });

  it("clé de dédoublonnage : `deviceId` DISTINCT → deux lignes (même minute)", async () => {
    const repo = createMemoryRepo();

    const first = await recordPushConflicts(
      repo,
      [makeEntry({ deviceId: "device-a" })],
      T0,
    );
    const second = await recordPushConflicts(
      repo,
      [makeEntry({ deviceId: "device-b" })],
      T0,
    );

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(repo.rows.map((row) => row.deviceId)).toEqual(["device-a", "device-b"]);
  });

  it("dédoublonnage DANS le lot : deux fois la même entrée → une ligne", async () => {
    const repo = createMemoryRepo();

    const inserted = await recordPushConflicts(
      repo,
      [makeEntry(), makeEntry(), makeEntry({ rowId: "row-2" })],
      T0,
    );

    expect(inserted).toBe(2);
    expect(repo.rows).toHaveLength(2);
  });

  it("entrées malformées écartées (jamais journalisées)", async () => {
    const repo = createMemoryRepo();

    const inserted = await recordPushConflicts(
      repo,
      [
        { table: "", rowId: "p-1", reason: "vide" },
        { table: "patient", rowId: "", reason: "vide" },
        { table: "patient", rowId: "p-1", reason: "" },
      ],
      T0,
    );

    expect(inserted).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it("horloge caduque → throw (contrat « now injecté »)", async () => {
    const repo = createMemoryRepo();
    await expect(recordPushConflicts(repo, [makeEntry()], new Date(Number.NaN))).rejects.toThrow(
      /caduque/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Sécurité — projection et purification                                    */
/* -------------------------------------------------------------------------- */

describe("recordPushConflicts — aucun secret dans le journal local", () => {
  it("projette les payloads : `passwordHash` n'est JAMAIS stocké", async () => {
    const repo = createMemoryRepo();
    const hash = "$2b$10$uneSaltEtUnHashNeDoitJamaisApparaitre";

    const inserted = await recordPushConflicts(
      repo,
      [
        makeEntry({
          table: "user",
          rowId: "u-1",
          winning: { id: "u-1", email: "a@exemple.dz", passwordHash: hash },
          losing: { id: "u-1", password_hash: hash, sessionToken: "jeton-de-session" },
        }),
      ],
      T0,
    );

    expect(inserted).toBe(1);
    const stored = JSON.stringify(repo.rows);
    expect(stored).not.toContain("passwordHash");
    expect(stored).not.toContain("password_hash");
    expect(stored).not.toContain("sessionToken");
    expect(stored).not.toContain(hash);
    // …mais les colonnes de profil légitimes sont conservées.
    expect(repo.rows[0]?.winning).toMatchObject({ id: "u-1", email: "a@exemple.dz" });
  });

  it("nettoie les secrets cachés dans les VALEURS d'un payload (serveur compromis)", async () => {
    const repo = createMemoryRepo();

    await recordPushConflicts(
      repo,
      [
        makeEntry({
          table: "patient",
          rowId: "p-1",
          winning: {
            id: "p-1",
            notes: "contact : token=secret-valeur-1234",
            address: "Bearer abcdefghijklmnop",
          },
        }),
      ],
      T0,
    );

    const stored = JSON.stringify(repo.rows);
    expect(stored).not.toContain("secret-valeur-1234");
    expect(stored).not.toContain("abcdefghijklmnop");
    expect(stored).toContain("token=[redacted]");
    expect(stored).toContain("Bearer [redacted]");
  });

  it("motif rédigé et borné : ni jeton, ni `DATABASE_URL`, ni URL avec identifiants", async () => {
    const repo = createMemoryRepo();

    await recordPushConflicts(
      repo,
      [
        makeEntry({
          reason:
            "échec central Bearer eyJhbGciOi.123456 DATABASE_URL=postgres://app:pg-secret@127.0.0.1:5432/dental",
        }),
      ],
      T0,
    );

    const stored = JSON.stringify(repo.rows);
    expect(stored).not.toContain("eyJhbGciOi.123456");
    expect(stored).not.toContain("pg-secret");
    expect(stored).not.toContain("127.0.0.1:5432/dental");
    expect(stored).toContain("[redacted]");
    expect(repo.rows[0]?.reason?.length).toBeLessThanOrEqual(500);
  });

  it("table hors registre : le payload n'est PAS stocké (l'entrée si, avec son motif)", async () => {
    const repo = createMemoryRepo();

    const inserted = await recordPushConflicts(
      repo,
      [
        makeEntry({
          table: "table_inconnue",
          rowId: "x-1",
          winning: { id: "x-1", passwordHash: "hash" },
          losing: { id: "x-1" },
        }),
      ],
      T0,
    );

    expect(inserted).toBe(1);
    expect(repo.rows[0]?.winning).toBeNull();
    expect(repo.rows[0]?.losing).toBeNull();
    expect(repo.rows[0]?.reason).toBe("base-rev-mismatch");
    expect(JSON.stringify(repo.rows)).not.toContain("hash");
  });

  it("sanitizeConflictReason retire les secrets sans planter sur du texte ordinaire", () => {
    expect(sanitizeConflictReason("conflit LWW sur ligne verrouillée")).toBe(
      "conflit LWW sur ligne verrouillée",
    );
    expect(sanitizeConflictReason("password=hunter2 reste à lire")).toContain(
      "password=[redacted]",
    );
    expect(sanitizeConflictReason("password=hunter2")).not.toContain("hunter2");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. journalConflict — mode `unresolved` (revue D-5)                          */
/* -------------------------------------------------------------------------- */

describe("journalConflict — mode `unresolved`", () => {
  it("n'ouvre qu'une seule entrée par paire tant qu'elle n'est pas tranchée", async () => {
    const repo = createMemoryRepo();

    const first = await journalConflict(repo, makeEntry({ rowId: "p-1" }), T0, {
      mode: "unresolved",
    });
    const second = await journalConflict(
      repo,
      makeEntry({ rowId: "p-1", reason: "merge-review:d5-garde-fou" }),
      LATER,
      { mode: "unresolved" },
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(repo.rows).toHaveLength(1);

    // Résolue → la paire peut être à nouveau journalisée.
    await resolveConflict(repo, { id: first.id, resolvedBy: "dr-dupont" });
    const third = await journalConflict(repo, makeEntry({ rowId: "p-1" }), LATER, {
      mode: "unresolved",
    });
    expect(third.inserted).toBe(true);
    expect(repo.rows).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. listConflicts / resolveConflict — revue humaine                          */
/* -------------------------------------------------------------------------- */

describe("listConflicts / resolveConflict", () => {
  async function seed(repo: ConflictRepo): Promise<void> {
    await recordPushConflicts(
      repo,
      [
        makeEntry({ table: "patient", rowId: "p-1" }),
        makeEntry({ table: "patient", rowId: "p-2", deviceId: "device-a" }),
        makeEntry({ table: "invoice", rowId: "i-1" }),
      ],
      T0,
    );
  }

  it("filtre par table, rowId, deviceId et état de résolution", async () => {
    const repo = createMemoryRepo();
    await seed(repo);

    const all = await listConflicts(repo);
    expect(all).toHaveLength(3);

    const patients = await listConflicts(repo, { table: "patient" });
    expect(patients.map((row) => row.rowId)).toEqual(["p-1", "p-2"]);

    const one = await listConflicts(repo, { table: "patient", rowId: "p-1" });
    expect(one).toHaveLength(1);

    const byDevice = await listConflicts(repo, { deviceId: "device-a" });
    expect(byDevice.map((row) => row.rowId)).toEqual(["p-2"]);
  });

  it("`unresolvedOnly` ne renvoie que la file de revue", async () => {
    const repo = createMemoryRepo();
    await seed(repo);
    const [first] = await listConflicts(repo, { table: "patient", rowId: "p-1" });

    await resolveConflict(repo, { id: first?.id ?? "", resolvedBy: "dr-dupont" });

    const unresolved = await listConflicts(repo, { unresolvedOnly: true });
    expect(unresolved.map((row) => row.rowId)).toEqual(["p-2", "i-1"]);
    const resolved = await listConflicts(repo, { unresolvedOnly: false });
    expect(resolved).toHaveLength(3);
  });

  it("resolveConflict pose `resolved_by` / `resolved_at` et reste idempotent", async () => {
    const repo = createMemoryRepo();
    await seed(repo);
    const [target] = await listConflicts(repo, { table: "patient", rowId: "p-1" });
    const id = target?.id ?? "";
    const at = new Date("2026-06-02T09:00:00.000Z");

    await resolveConflict(repo, { id, resolvedBy: "dr-dupont", resolvedAt: at });
    const resolved = await listConflicts(repo, { table: "patient", rowId: "p-1" });
    expect(resolved[0]).toMatchObject({ resolvedBy: "dr-dupont", resolvedAt: at });

    await resolveConflict(repo, { id, resolvedBy: "dr-autre" });
    const still = await listConflicts(repo, { table: "patient", rowId: "p-1" });
    expect(still[0]?.resolvedBy).toBe("dr-dupont");
  });

  it("paramètres invalides → rejet Zod (aucune requête lancée)", async () => {
    const repo = createMemoryRepo();
    await expect(listConflicts(repo, { limit: 0 })).rejects.toThrow();
    await expect(
      resolveConflict(repo, { id: "", resolvedBy: "dr-dupont" }),
    ).rejects.toThrow();
  });

  it("identifiant inconnu → no-op silencieux", async () => {
    const repo = createMemoryRepo();
    await expect(
      resolveConflict(repo, { id: "fantome", resolvedBy: "dr-dupont" }),
    ).resolves.toBeUndefined();
    expect(repo.rows).toHaveLength(0);
  });
});
