import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  APPLY_REASON,
  CURSOR_COLUMNS,
  applyPulledChanges,
  type ApplyOptions,
  type LocalApplyRepo,
  type LocalApplyTx,
  type Row,
} from "./local-apply";
import {
  TABLE_REGISTRY,
  getReplicatedTable,
  type ChangeOp,
} from "./protocol";

/**
 * Tests **hermétiques** (repo mémoire, aucune base, aucun réseau) de
 * l'application LOCALE des changements tirés — tâche 5.4.
 *
 * Le repo mémoire reproduit fidèlement le contrat du chemin de production :
 * `upsertRow` insère si la ligne est absente, applique le **patch** sinon
 * (jamais de suppression — le rollback est trivial puisque `upsertRow` ne lève
 * qu'*avant* toute mutation). Il expose **une seule** méthode, `transaction` :
 * structurellement incapable d'écrire dans `sync_outbox` (A5), ce que les tests
 * vérifient explicitement.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const OLD = new Date("2026-01-15T08:00:00.000Z");
const LATER = new Date("2026-03-01T12:05:00.000Z");
const TOMBSTONE = new Date("2026-02-20T09:30:00.000Z");
const CLINIC = "clinic-a";

function makeOp(
  overrides: Partial<ChangeOp> & Pick<ChangeOp, "table" | "rowId" | "op">,
): ChangeOp {
  return {
    opId: crypto.randomUUID(),
    payload: {},
    clinicId: CLINIC,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    isRowLocallyPending: async () => false,
    now: NOW,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Repo mémoire                                                                */
/* -------------------------------------------------------------------------- */

interface MemoryWrite {
  table: string;
  rowId: string;
  insert: Row;
  update: Row;
}

interface MemoryState {
  /** `${table}::${rowId}` → ligne (colonnes Drizzle). */
  rows: Map<string, Row>;
  writes: MemoryWrite[];
  /** Nombre de transactions ouvertes (une par opération appliquée). */
  transactions: number;
  /** Tables dont l'écriture doit échouer (test d'isolation A6). */
  failTables: Set<string>;
}

interface MemoryHarness {
  repo: LocalApplyRepo;
  state: MemoryState;
  seed(table: string, rowId: string, row: Row): void;
  row(table: string, rowId: string): Row | undefined;
  writes(): MemoryWrite[];
}

function rowKey(table: string, rowId: string): string {
  return `${table}::${rowId}`;
}

function createMemoryRepo(): MemoryHarness {
  const state: MemoryState = {
    rows: new Map(),
    writes: [],
    transactions: 0,
    failTables: new Set(),
  };

  const tx: LocalApplyTx = {
    async upsertRow(table, rowId, insert, update) {
      // A6 : la défaillance survient AVANT toute mutation → rollback trivial.
      if (state.failTables.has(table)) {
        throw new Error(`memory-repo : écriture forcée en échec sur « ${table} ».`);
      }
      state.writes.push({ table, rowId, insert: { ...insert }, update: { ...update } });
      const key = rowKey(table, rowId);
      const existing = state.rows.get(key);
      // Sémantique ON CONFLICT (id) : patch si présent, valeurs d'insert sinon.
      state.rows.set(key, existing ? { ...existing, ...update } : { ...insert });
    },
  };

  const repo: LocalApplyRepo = {
    async transaction(fn) {
      state.transactions += 1;
      return fn(tx);
    },
  };

  return {
    repo,
    state,
    seed(table, rowId, row) {
      state.rows.set(rowKey(table, rowId), { ...row });
    },
    row(table, rowId) {
      return state.rows.get(rowKey(table, rowId));
    },
    writes() {
      return state.writes;
    },
  };
}

/** Chaque clé écrite doit appartenir à la liste blanche du registre (A3). */
function expectWhitelisted(writes: MemoryWrite[]): void {
  for (const write of writes) {
    const entry = getReplicatedTable(write.table);
    expect(entry, `table inconnue du registre : « ${write.table} »`).toBeDefined();
    if (!entry) continue;
    const allowed = new Set<string>([...entry.columns, "id"]);
    if (entry.cursor) for (const column of CURSOR_COLUMNS) allowed.add(column);
    for (const column of Object.keys(write.insert)) {
      expect(
        allowed.has(column),
        `${write.table}.insert contient une colonne hors liste blanche : « ${column} »`,
      ).toBe(true);
    }
    for (const column of Object.keys(write.update)) {
      expect(
        allowed.has(column),
        `${write.table}.update contient une colonne hors liste blanche : « ${column} »`,
      ).toBe(true);
    }
  }
}

/* -------------------------------------------------------------------------- */

describe("applyPulledChanges — A1 : ne jamais écraser le travail local", () => {
  it("ligne dont l'outbox locale est encore `pending` → ignorée, jamais écrasée", async () => {
    const h = createMemoryRepo();
    const localWork: Row = {
      id: "p1",
      firstName: "Local",
      lastName: "EnCours",
      rev: 3,
      createdAt: OLD,
      updatedAt: OLD,
      deletedAt: null,
    };
    h.seed("patient", "p1", localWork);

    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 9,
      payload: {
        id: "p1",
        firstName: "Serveur",
        lastName: "Autre",
        rev: 9,
        clinicId: CLINIC,
        updatedAt: LATER.toISOString(),
        deletedAt: null,
      },
    });

    const result = await applyPulledChanges(
      h.repo,
      [op],
      makeOptions({
        isRowLocallyPending: async (table, rowId) =>
          table === "patient" && rowId === "p1",
      }),
    );

    expect(result).toEqual({
      applied: 0,
      skippedPending: 1,
      skippedUnknown: 0,
      errors: [],
    });
    expect(h.writes()).toHaveLength(0);
    expect(h.state.transactions).toBe(0);
    expect(h.row("patient", "p1")).toEqual(localWork);
  });

  it("ligne sans entrée pendante → appliquée (rev / updated_at / deleted_at du serveur)", async () => {
    const h = createMemoryRepo();
    h.seed("patient", "p1", {
      id: "p1",
      firstName: "Avant",
      rev: 1,
      createdAt: OLD,
      updatedAt: OLD,
      deviceId: "device-local",
      deletedAt: null,
    });

    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 7,
      deviceId: "device-central",
      updatedAt: LATER.toISOString(),
      payload: {
        id: "p1",
        firstName: "Apres",
        // Valeurs « périmées » du payload : les colonnes de curseur serventur
        // du serveur (niveau op) priment.
        rev: 1,
        deviceId: "device-stale",
        updatedAt: OLD.toISOString(),
        clinicId: CLINIC,
        createdAt: OLD.toISOString(),
        deletedAt: TOMBSTONE.toISOString(),
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    const row = h.row("patient", "p1");
    expect(row?.firstName).toBe("Apres");
    expect(row?.rev).toBe(7);
    expect(row?.updatedAt).toEqual(LATER);
    expect(row?.deviceId).toBe("device-central");
    // Op vivante (`update`) : le central n'émet `insert` que pour une ligne
    // vivante → `deleted_at` remis à NULL (la ligne était un ancien tombstone).
    expect(row?.deletedAt).toBeNull();
    expect(h.state.transactions).toBe(1);
    expectWhitelisted(h.writes());
  });
});

describe("applyPulledChanges — A2 : projection (aucun secret écrit)", () => {
  it("password_hash absent du payload appliqué et JAMAIS écrit", async () => {
    const h = createMemoryRepo();
    const op = makeOp({
      table: "user",
      rowId: "u1",
      op: "insert",
      rev: 2,
      payload: {
        id: "u1",
        name: "Dr Benali",
        email: "dr@clinic.dz",
        tokenVersion: 4,
        passwordHash: "$2b$10$avant-hachage",
        password_hash: "$2b$10$avant-hachage",
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    const write = h.writes()[0];
    expect(write).toBeDefined();
    for (const column of ["passwordHash", "password_hash"]) {
      expect(write.insert).not.toHaveProperty(column);
      expect(write.update).not.toHaveProperty(column);
    }
    expect(write.insert.email).toBe("dr@clinic.dz");
    expect(write.insert.tokenVersion).toBe(4);
    expect(write.insert.rev).toBe(2);
    expect(h.row("user", "u1")).not.toHaveProperty("passwordHash");
    expectWhitelisted(h.writes());
  });
});

describe("applyPulledChanges — A3 : upsert whitelisté, created_at préservé", () => {
  it("mise à jour : created_at CONSERVÉ (jamais remplacé par now)", async () => {
    const h = createMemoryRepo();
    h.seed("patient", "p1", {
      id: "p1",
      firstName: "A",
      createdAt: OLD,
      updatedAt: OLD,
      rev: 1,
      deletedAt: null,
    });

    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 2,
      payload: {
        id: "p1",
        firstName: "B",
        // La source tente même d'imposer une autre date de création.
        createdAt: LATER.toISOString(),
        clinicId: CLINIC,
        updatedAt: NOW.toISOString(),
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.applied).toBe(1);
    const write = h.writes()[0];
    expect(write.update).not.toHaveProperty("createdAt");
    expect(write.insert).toHaveProperty("createdAt");
    const row = h.row("patient", "p1");
    expect(row?.createdAt).toEqual(OLD);
    expect(row?.createdAt).not.toEqual(NOW);
    expect(row?.firstName).toBe("B");
  });

  it("ligne neuve : created_at copié depuis la source (pas now())", async () => {
    const h = createMemoryRepo();
    const sourceCreatedAt = "2025-06-10T07:45:00.000Z";

    const op = makeOp({
      table: "patient",
      rowId: "p2",
      op: "insert",
      rev: 1,
      payload: {
        id: "p2",
        firstName: "Neuf",
        clinicId: CLINIC,
        createdAt: sourceCreatedAt,
        updatedAt: NOW.toISOString(),
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.applied).toBe(1);
    const row = h.row("patient", "p2");
    expect(row?.createdAt).toEqual(new Date(sourceCreatedAt));
    expect(row?.createdAt).not.toEqual(NOW);
    expectWhitelisted(h.writes());
  });
});

describe("applyPulledChanges — A4 : tombstones (soft delete)", () => {
  it("delete sur une ligne existante → deleted_at posé, ligne TOUJOURS présente", async () => {
    const h = createMemoryRepo();
    h.seed("patient", "p1", {
      id: "p1",
      firstName: "A",
      rev: 2,
      createdAt: OLD,
      updatedAt: OLD,
      deletedAt: null,
    });

    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "delete",
      rev: 3,
      updatedAt: LATER.toISOString(),
      payload: {
        id: "p1",
        firstName: "A",
        rev: 2,
        clinicId: CLINIC,
        createdAt: OLD.toISOString(),
        deletedAt: TOMBSTONE.toISOString(),
        updatedAt: LATER.toISOString(),
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    const row = h.row("patient", "p1");
    expect(row, "la tombstone ne doit JAMAIS supprimer la ligne").toBeDefined();
    expect(row?.deletedAt).toEqual(TOMBSTONE);
    expect(row?.rev).toBe(3);
    expect(row?.updatedAt).toEqual(LATER);
    expectWhitelisted(h.writes());
  });

  it("delete pour une ligne absente → tombstone insérée (upsert, pas de DELETE)", async () => {
    const h = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p-absente",
      op: "delete",
      rev: 5,
      updatedAt: LATER.toISOString(),
      payload: {
        id: "p-absente",
        clinicId: CLINIC,
        deletedAt: TOMBSTONE.toISOString(),
        updatedAt: LATER.toISOString(),
      },
    });

    const result = await applyPulledChanges(h.repo, [op], makeOptions());

    expect(result.applied).toBe(1);
    const row = h.row("patient", "p-absente");
    expect(row).toBeDefined();
    expect(row?.deletedAt).toEqual(TOMBSTONE);
    // Aucune suppression possible : le repo n'expose qu'une seule écriture.
    expect(Object.keys(h.repo)).toEqual(["transaction"]);
  });
});

describe("applyPulledChanges — A7 : tables hors périmètre", () => {
  it("table `push-only` (audit_log) → skippedUnknown, sans exception", async () => {
    const h = createMemoryRepo();
    const result = await applyPulledChanges(
      h.repo,
      [makeOp({ table: "audit_log", rowId: "a1", op: "insert", payload: { id: "a1" } })],
      makeOptions(),
    );

    expect(result).toEqual({
      applied: 0,
      skippedPending: 0,
      skippedUnknown: 1,
      errors: [],
    });
    expect(h.writes()).toHaveLength(0);
  });

  it("table inconnue (dont `sync_outbox`) → skippedUnknown, sans exception", async () => {
    const h = createMemoryRepo();
    const result = await applyPulledChanges(
      h.repo,
      [
        makeOp({ table: "sync_outbox", rowId: "o1", op: "insert", payload: { id: "o1" } }),
        makeOp({ table: "table_inexistante", rowId: "x", op: "update", payload: {} }),
      ],
      makeOptions(),
    );

    expect(result.skippedUnknown).toBe(2);
    expect(result.errors).toEqual([]);
    expect(h.writes()).toHaveLength(0);
  });

  it("filtre de portée du jeton d'appareil qui refuse → skippedUnknown", async () => {
    const h = createMemoryRepo();
    const result = await applyPulledChanges(
      h.repo,
      [makeOp({ table: "patient", rowId: "p1", op: "insert", payload: { id: "p1" } })],
      makeOptions({ deviceTokenRowFilter: async () => false }),
    );

    expect(result.skippedUnknown).toBe(1);
    expect(result.applied).toBe(0);
    expect(h.writes()).toHaveLength(0);
  });
});

describe("applyPulledChanges — A6 : erreurs isolées", () => {
  it("échec d'écriture d'une ligne → collectée, le lot continue", async () => {
    const h = createMemoryRepo();
    h.state.failTables.add("patient");

    const ops = [
      makeOp({
        table: "patient",
        rowId: "p1",
        op: "insert",
        payload: { id: "p1", clinicId: CLINIC },
      }),
      makeOp({
        table: "invoice",
        rowId: "i1",
        op: "insert",
        payload: { id: "i1", clinicId: CLINIC, number: "F-2026-1" },
      }),
    ];

    const result = await applyPulledChanges(h.repo, ops, makeOptions());

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      rowId: "p1",
      table: "patient",
    });
    expect(result.errors[0].reason).toContain(APPLY_REASON.writeFailed);
    expect(h.writes().map((w) => w.table)).toEqual(["invoice"]);
    expect(h.row("patient", "p1")).toBeUndefined();
  });

  it("op malformée (Zod) → collectée, le lot continue", async () => {
    const h = createMemoryRepo();
    const malformed = {
      ...makeOp({ table: "invoice", rowId: "i-broken", op: "insert", payload: { id: "i-broken" } }),
      updatedAt: "pas-un-horodatage",
    } as ChangeOp;

    const result = await applyPulledChanges(
      h.repo,
      [
        malformed,
        makeOp({
          table: "invoice",
          rowId: "i-ok",
          op: "insert",
          payload: { id: "i-ok", clinicId: CLINIC },
        }),
      ],
      makeOptions(),
    );

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rowId).toBe("i-broken");
    expect(result.errors[0].reason).toContain(APPLY_REASON.invalidOp);
    expect(h.row("invoice", "i-ok")).toBeDefined();
  });

  it("`delete` sur une table enfant (sans tombstone) → collectée, jamais de DELETE", async () => {
    const h = createMemoryRepo();
    h.seed("invoice_item", "l1", { id: "l1", invoiceId: "i1", description: "soin" });

    const result = await applyPulledChanges(
      h.repo,
      [makeOp({ table: "invoice_item", rowId: "l1", op: "delete", payload: {} })],
      makeOptions(),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain(APPLY_REASON.childDelete);
    expect(h.writes()).toHaveLength(0);
    expect(h.row("invoice_item", "l1")).toBeDefined();
  });

  it("horloge `now` caduque → refus total (aucun lot partiel)", async () => {
    const h = createMemoryRepo();
    await expect(
      applyPulledChanges(h.repo, [], makeOptions({ now: new Date("pas-une-date") })),
    ).rejects.toThrow(/now/);
    expect(h.state.transactions).toBe(0);
  });
});

describe("applyPulledChanges — A5 : AUCUNE écriture dans sync_outbox", () => {
  it("le repo exposé ne offre aucune capacité d'écriture hors upsert", async () => {
    const h = createMemoryRepo();
    // Surface d'I/O minimale : `transaction` → `upsertRow`. Ni file, ni curseur.
    expect(Object.keys(h.repo)).toEqual(["transaction"]);

    const result = await applyPulledChanges(
      h.repo,
      [
        makeOp({
          table: "patient",
          rowId: "p1",
          op: "insert",
          payload: { id: "p1", clinicId: CLINIC },
        }),
      ],
      makeOptions(),
    );
    expect(result.applied).toBe(1);

    const infrastructure = new Set([
      "sync_outbox",
      "sync_state",
      "sync_conflict",
      "sync_merge",
      "sync_applied",
      "device",
    ]);
    for (const write of h.writes()) {
      expect(infrastructure.has(write.table), `écriture interdite : ${write.table}`).toBe(false);
      expect(TABLE_REGISTRY[write.table], `hors registre : ${write.table}`).toBeDefined();
    }
    expect(h.state.writes.every((w) => w.table !== "sync_outbox")).toBe(true);
  });

  it("la source du module ne référence aucun appel d'écriture de la file", () => {
    const source = readFileSync(new URL("./local-apply.ts", import.meta.url), "utf8");
    // Aucune journalisation de mutation (sinon boucle push ↔ pull)…
    expect(source).not.toMatch(/\binsertOutbox\s*\(/);
    expect(source).not.toMatch(/\benqueueInTransaction\s*\(/);
    // …et aucun avancement du curseur : il appartient à l'appelant (étape 5.5).
    expect(source).not.toMatch(/\bwriteCursor\s*\(/);
    expect(source).not.toMatch(/from ["']\.\.\/db\/db["']/);
  });
});

describe("applyPulledChanges — A8 : enfants (Groupe B)", () => {
  it("sont appliqués comme des ops à part entière, dans l'ordre reçu", async () => {
    const h = createMemoryRepo();
    const ops = [
      makeOp({
        table: "invoice",
        rowId: "i1",
        op: "insert",
        rev: 1,
        payload: { id: "i1", clinicId: CLINIC, number: "F-1", total: "120.00" },
      }),
      makeOp({
        table: "invoice_item",
        rowId: "l1",
        op: "insert",
        payload: { id: "l1", invoiceId: "i1", description: "Détartrage", quantity: 1 },
      }),
      makeOp({
        table: "invoice_item",
        rowId: "l2",
        op: "insert",
        payload: { id: "l2", invoiceId: "i1", description: "Soin", quantity: 2 },
      }),
    ];

    const result = await applyPulledChanges(h.repo, ops, makeOptions());

    expect(result.applied).toBe(3);
    expect(result.errors).toEqual([]);
    expect(h.writes().map((w) => `${w.table}:${w.rowId}`)).toEqual([
      "invoice:i1",
      "invoice_item:l1",
      "invoice_item:l2",
    ]);
    expect(h.state.transactions).toBe(3);

    // A8 : pas de colonnes de curseur sur les enfants (cursor: false).
    const child = h.writes()[1];
    for (const column of CURSOR_COLUMNS) {
      expect(child.insert).not.toHaveProperty(column);
      expect(child.update).not.toHaveProperty(column);
    }
    expect(child.insert.id).toBe("l1");
    expect(child.insert.invoiceId).toBe("i1");
    expect(child.insert).not.toHaveProperty("createdAt");
    expectWhitelisted(h.writes());
    expect(h.row("invoice_item", "l1")?.description).toBe("Détartrage");
  });
});

describe("applyPulledChanges — garde-fous transverses", () => {
  it("lot vide → compteurs à zéro, aucune transaction", async () => {
    const h = createMemoryRepo();
    const result = await applyPulledChanges(h.repo, [], makeOptions());
    expect(result).toEqual({
      applied: 0,
      skippedPending: 0,
      skippedUnknown: 0,
      errors: [],
    });
    expect(h.state.transactions).toBe(0);
  });

  it("chaque colonne d'écriture existe réellement dans la table Drizzle", () => {
    for (const entry of Object.values(TABLE_REGISTRY)) {
      const columns = getTableColumns(entry.table) as Record<string, unknown>;
      expect(columns.id, `${entry.name}.id`).toBeDefined();
      for (const column of entry.columns) {
        expect(columns[column], `${entry.name}.${column} absente de la table`).toBeDefined();
      }
      if (entry.cursor) {
        for (const column of CURSOR_COLUMNS) {
          expect(columns[column], `${entry.name}.${column} absente de la table`).toBeDefined();
        }
      }
    }
  });
});
