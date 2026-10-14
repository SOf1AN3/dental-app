import { describe, expect, it } from "vitest";
import {
  AlreadyAppliedError,
  CHILD_PARENT_REFS,
  MIN_PULL_CURSOR,
  PROTECTED_AMOUNT_FIELDS,
  REJECT,
  RejectedOpError,
  SyncScopeError,
  applyOps,
  fetchChanges,
  pullScopeOf,
  rowWithinScope,
  type CentralStoreRepo,
  type CentralStoreTx,
  type NewConflictRow,
  type PullScope,
  type Row,
} from "./central-store";
import type { DeviceTokenContext } from "./central-auth";
import { TABLE_REGISTRY, type ChangeOp, type PullRequest } from "./protocol";

/**
 * Tests **hermétiques** (repo mémoire, aucune base, aucun réseau) du cœur
 * serveur de la synchronisation — tâche 5.2b.
 *
 * Le repo mémoire est **volontairement naïf** : `listChangedRows` ne filtre
 * PAS par portée (il renvoie toutes les lignes de la table). C'est délibéré :
 * cela prouve que la couche pure `fetchChanges` rejette elle-même les lignes
 * d'un cabinet étranger (défense en profondeur anti-IDOR), indépendamment du
 * SQL. Le chemin de production (`createCentralStoreDbRepo`) filtre en plus en
 * SQL, sur les index `*_clinic_updated_id`.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const LATER = new Date("2026-03-01T12:05:00.000Z");

const CLINIC_A = "clinic-a";
const CLINIC_B = "clinic-b";

function makeCtx(clinicIds: string[] = [CLINIC_A]): DeviceTokenContext {
  return {
    deviceId: "device-1",
    userId: "user-owner",
    clinicIds,
    trustExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
  };
}

function makeOp(overrides: Partial<ChangeOp> & Pick<ChangeOp, "table" | "rowId" | "op">): ChangeOp {
  return {
    opId: crypto.randomUUID(),
    payload: {},
    clinicId: CLINIC_A,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Repo mémoire                                                                */
/* -------------------------------------------------------------------------- */

interface MemoryState {
  /** table → rowId → ligne brute (colonnes Drizzle). */
  rows: Map<string, Map<string, Row>>;
  applied: Set<string>;
  conflicts: NewConflictRow[];
  /** userId → clinicIds (membretés actives). */
  memberships: Map<string, string[]>;
  /** Compteur d'écritures de DONNÉES (hors `sync_applied`) — idempotence. */
  writes: number;
  /** Tables dont `writeRow` doit échouer (test d'atomicité A1). */
  failWritesFor: Set<string>;
}

interface MemoryHarness {
  repo: CentralStoreRepo;
  state: MemoryState;
  seed(table: string, rowId: string, row: Row): void;
  getRow(table: string, rowId: string): Row | undefined;
}

function createMemoryRepo(seed?: Partial<MemoryState>): MemoryHarness {
  const state: MemoryState = {
    rows: new Map(),
    applied: new Set(),
    conflicts: [],
    memberships: new Map(),
    writes: 0,
    failWritesFor: new Set(),
    ...seed,
  };

  const harness: MemoryHarness = {
    state,
    repo: undefined as unknown as CentralStoreRepo,
    seed(table, rowId, row) {
      let tableRows = state.rows.get(table);
      if (!tableRows) {
        tableRows = new Map();
        state.rows.set(table, tableRows);
      }
      tableRows.set(rowId, { ...row });
    },
    getRow(table, rowId) {
      return state.rows.get(table)?.get(rowId);
    },
  };

  function makeTx(): CentralStoreTx {
    return {
      async findRow(table, rowId) {
        const row = state.rows.get(table)?.get(rowId);
        return row === undefined ? null : { ...row };
      },
      async writeRow(table, rowId, values, mode) {
        if (state.failWritesFor.has(table)) {
          throw new Error(`memory-repo : écriture forcée en échec sur « ${table} ».`);
        }
        let tableRows = state.rows.get(table);
        if (!tableRows) {
          tableRows = new Map();
          state.rows.set(table, tableRows);
        }
        const existing = tableRows.get(rowId);
        tableRows.set(
          rowId,
          mode === "insert" || existing === undefined
            ? { ...values }
            : { ...existing, ...values },
        );
        state.writes += 1;
      },
      async markApplied(opId) {
        if (state.applied.has(opId)) return false;
        state.applied.add(opId);
        return true;
      },
      async insertConflict(conflict) {
        state.conflicts.push(conflict);
      },
    };
  }

  harness.repo = {
    async findApplied(opIds) {
      return new Set(opIds.filter((id) => state.applied.has(id)));
    },
    async listUserIdsInClinicScope(clinicIds) {
      const out = new Set<string>();
      for (const [userId, clinics] of state.memberships) {
        if (clinics.some((c) => clinicIds.includes(c))) out.add(userId);
      }
      return out;
    },
    async transaction(fn) {
      // Snapshot → rollback intégral sur erreur : reproduit le contrat SQL.
      const snapshot = structuredClone({
        rows: state.rows,
        applied: state.applied,
        conflicts: state.conflicts,
        writes: state.writes,
      });
      try {
        return await fn(makeTx());
      } catch (error) {
        state.rows = snapshot.rows;
        state.applied = snapshot.applied;
        state.conflicts = snapshot.conflicts;
        state.writes = snapshot.writes;
        throw error;
      }
    },
    async listChangedRows(query) {
      // NAÏF VOLONTAIREMENT : aucun filtre de portée (voir en-tête de fichier).
      const tableRows = state.rows.get(query.table);
      if (!tableRows) return [];
      const sorted = [...tableRows.values()].sort((a, b) => {
        const ta = timeOf(a.updatedAt);
        const tb = timeOf(b.updatedAt);
        if (ta !== tb) return ta < tb ? -1 : 1;
        return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
      });
      const cursorTime = query.cursor.updatedAt.getTime();
      return sorted
        .filter((row) => {
          const t = timeOf(row.updatedAt);
          if (t !== cursorTime) return t > cursorTime;
          return String(row.id) > query.cursor.id;
        })
        .slice(0, query.limit)
        .map((row) => ({ ...row }));
    },
    async listChildRows(query) {
      const ref = CHILD_PARENT_REFS[query.childTable];
      if (!ref) return [];
      const tableRows = state.rows.get(query.childTable);
      if (!tableRows) return [];
      return [...tableRows.values()]
        .filter((row) => query.parentRowIds.includes(String(row[ref.parentKey])))
        .map((row) => ({ ...row }));
    },
  };

  return harness;
}

function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

function pullRequest(overrides: Partial<PullRequest> & { clinicId: string }): PullRequest {
  return { cursor: null, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* 1. Cohérence du registre                                                    */
/* -------------------------------------------------------------------------- */

describe("cohérence CHILD_PARENT_REFS ↔ TABLE_REGISTRY", () => {
  it("couvre exactement les enfants déclarés par le registre", () => {
    const declared = new Set<string>();
    for (const entry of Object.values(TABLE_REGISTRY)) {
      for (const child of entry.children ?? []) declared.add(child);
    }
    expect(new Set(Object.keys(CHILD_PARENT_REFS))).toEqual(declared);
  });

  it("chaque enfant déclare bien son parent comme ayant cet enfant", () => {
    for (const [child, ref] of Object.entries(CHILD_PARENT_REFS)) {
      const parent = TABLE_REGISTRY[ref.parentTable];
      expect(parent, `parent de ${child}`).toBeDefined();
      expect(parent.children ?? []).toContain(child);
    }
  });

  it("PROTECTED_AMOUNT_FIELDS ne nomme que des colonnes du registre", () => {
    for (const [table, fields] of Object.entries(PROTECTED_AMOUNT_FIELDS)) {
      const columns = TABLE_REGISTRY[table]?.columns ?? [];
      for (const field of fields) {
        expect(columns, `${table}.${field}`).toContain(field);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. applyOps — règles A1 à A6                                                */
/* -------------------------------------------------------------------------- */

describe("applyOps — insert / update / rev serveur", () => {
  it("insert d'une ligne inexistante → rev = 1, deviceId et updatedAt serveur", async () => {
    const { repo, getRow } = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Amina", lastName: "B." },
    });

    const res = await applyOps(makeCtx(), [op], NOW, repo);

    expect(res.accepted).toEqual([op.opId]);
    expect(res.rejected).toEqual([]);
    const row = getRow("patient", "p1");
    expect(row).toMatchObject({
      rev: 1,
      clinicId: CLINIC_A,
      firstName: "Amina",
      deviceId: "device-1",
      deletedAt: null,
    });
    expect((row as Row).updatedAt).toEqual(NOW);
  });

  it("update avec baseRev correspondant → rev + 1, AUCUN conflit", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      firstName: "Avant",
      rev: 3,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 3,
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Apres" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    expect(res.conflicts).toEqual([]);
    expect(harness.state.conflicts).toEqual([]);
    expect(harness.getRow("patient", "p1")).toMatchObject({
      firstName: "Apres",
      rev: 4,
      deviceId: "device-1",
    });
  });

  it("un update ne réécrit JAMAIS createdAt", async () => {
    const harness = createMemoryRepo();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      rev: 1,
      createdAt,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 1,
      payload: { id: "p1", clinicId: CLINIC_A, createdAt: LATER.toISOString() },
    });

    await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect((harness.getRow("patient", "p1") as Row).createdAt).toEqual(createdAt);
  });
});

describe("applyOps — A1 idempotence", () => {
  it("rejeu d'un même opId → accepted, zéro 2ᵉ écriture", async () => {
    const harness = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Amina" },
    });

    const first = await applyOps(makeCtx(), [op], NOW, harness.repo);
    const writesAfterFirst = harness.state.writes;
    const second = await applyOps(makeCtx(), [op], LATER, harness.repo);

    expect(first.accepted).toEqual([op.opId]);
    expect(second.accepted).toEqual([op.opId]);
    expect(second.rejected).toEqual([]);
    expect(harness.state.writes).toBe(writesAfterFirst);
    expect((harness.getRow("patient", "p1") as Row).rev).toBe(1);
    expect((harness.getRow("patient", "p1") as Row).updatedAt).toEqual(NOW);
  });

  it("une op rejetée n'est PAS journalisée dans sync_applied", async () => {
    const harness = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      clinicId: "clinique-etrangere",
      payload: { id: "p1", clinicId: "clinique-etrangere" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.clinicMismatch }]);
    expect(harness.state.applied.size).toBe(0);
  });

  it("atomicité : échec d'écriture → rollback complet (ni donnée, ni admission)", async () => {
    const harness = createMemoryRepo();
    harness.state.failWritesFor.add("patient");
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      payload: { id: "p1", clinicId: CLINIC_A },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.applyError }]);
    expect(harness.state.applied.has(op.opId)).toBe(false);
    expect(harness.getRow("patient", "p1")).toBeUndefined();
  });

  it("course entre deux pushes : le perdant répond accepted sans ré-appliquer", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      firstName: "Vainqueur",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 1,
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Perdant" },
    });

    // Le push concurrent a gagné ENTRE `findApplied` et le BEGIN : l'opId
    // existe déjà dans `sync_applied` au moment du INSERT.
    const racingRepo: CentralStoreRepo = {
      ...harness.repo,
      findApplied: async () => new Set<string>(),
      transaction: (fn) =>
        harness.repo.transaction(async (tx) => {
          await tx.markApplied(op.opId, "device-concurrent", NOW);
          return fn(tx);
        }),
    };

    const res = await applyOps(makeCtx(), [op], LATER, racingRepo);

    expect(res.accepted).toEqual([op.opId]);
    expect(res.rejected).toEqual([]);
    // La transaction du perdant est annulée : la donnée du vainqueur survit.
    expect((harness.getRow("patient", "p1") as Row).firstName).toBe("Vainqueur");
    expect((harness.getRow("patient", "p1") as Row).rev).toBe(1);
  });

  it("AlreadyAppliedError est bien une Error (signal interne)", () => {
    expect(new AlreadyAppliedError()).toBeInstanceOf(Error);
  });
});

describe("applyOps — A2 direction", () => {
  it("une op `notification` (pull-only) est rejetée wrong-direction", async () => {
    const { repo, state } = createMemoryRepo();
    const op = makeOp({
      table: "notification",
      rowId: "n1",
      op: "insert",
      payload: { id: "n1", clinicId: CLINIC_A, title: "Broadcast" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.wrongDirection }]);
    expect(state.writes).toBe(0);
  });

  it("une table hors registre est rejetée unknown-table", async () => {
    const { repo } = createMemoryRepo();
    const op = makeOp({ table: "device", rowId: "d1", op: "insert" });

    const res = await applyOps(makeCtx(), [op], NOW, repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.unknownTable }]);
  });
});

describe("applyOps — A3 re-validation du clinicId", () => {
  it("clinicId hors ctx.clinicIds → clinic-mismatch (jamais cru au payload)", async () => {
    const harness = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      clinicId: CLINIC_B,
      payload: { id: "p1", clinicId: CLINIC_B },
    });

    const res = await applyOps(makeCtx([CLINIC_A]), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.clinicMismatch }]);
    expect(harness.getRow("patient", "p1")).toBeUndefined();
  });

  it("clinicId absent du payload ET d'op → clinic-mismatch", async () => {
    const { repo } = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      clinicId: null,
      payload: { id: "p1", firstName: "X" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, repo);

    expect(res.rejected[0]?.reason).toBe(REJECT.clinicMismatch);
  });

  it("payload et op.clinicId incohérents → clinic-mismatch", async () => {
    const { repo } = createMemoryRepo();
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "insert",
      clinicId: CLINIC_A,
      payload: { id: "p1", clinicId: CLINIC_B },
    });

    const res = await applyOps(makeCtx([CLINIC_A, CLINIC_B]), [op], NOW, repo);

    expect(res.rejected[0]?.reason).toBe(REJECT.clinicMismatch);
  });

  it("table `clinic` : seul un id ∈ ctx.clinicIds est accepté", async () => {
    const harness = createMemoryRepo();
    const ok = makeOp({
      table: "clinic",
      rowId: CLINIC_A,
      op: "insert",
      clinicId: null,
      payload: { id: CLINIC_A, name: "Cabinet A" },
    });
    const ko = makeOp({
      table: "clinic",
      rowId: CLINIC_B,
      op: "insert",
      clinicId: null,
      payload: { id: CLINIC_B, name: "Cabinet B" },
    });

    const res = await applyOps(makeCtx([CLINIC_A]), [ok, ko], NOW, harness.repo);

    expect(res.accepted).toEqual([ok.opId]);
    expect(res.rejected).toEqual([{ opId: ko.opId, reason: REJECT.clinicMismatch }]);
    expect(harness.getRow("clinic", CLINIC_A)).toBeDefined();
    expect(harness.getRow("clinic", CLINIC_B)).toBeUndefined();
  });

  it("table `user` : membre du cabinet accepté, non-membre rejeté", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([
        ["user-membre", [CLINIC_A]],
        ["user-autre", [CLINIC_B]],
      ]),
    });
    const ok = makeOp({
      table: "user",
      rowId: "user-membre",
      op: "insert",
      clinicId: null,
      payload: { id: "user-membre", name: "Dr A" },
    });
    const ko = makeOp({
      table: "user",
      rowId: "user-autre",
      op: "insert",
      clinicId: null,
      payload: { id: "user-autre", name: "Dr B" },
    });

    const res = await applyOps(makeCtx([CLINIC_A]), [ok, ko], NOW, harness.repo);

    expect(res.accepted).toEqual([ok.opId]);
    expect(res.rejected).toEqual([{ opId: ko.opId, reason: REJECT.clinicMismatch }]);
  });

  it("audit_log (clinic_id nullable) : valeur hors portée rejetée, null accepté", async () => {
    const harness = createMemoryRepo();
    const ko = makeOp({
      table: "audit_log",
      rowId: "a1",
      op: "insert",
      clinicId: CLINIC_B,
      payload: { id: "a1", clinicId: CLINIC_B, action: "create", entityType: "patient", entityId: "p1" },
    });
    const ok = makeOp({
      table: "audit_log",
      rowId: "a2",
      op: "insert",
      clinicId: null,
      payload: { id: "a2", clinicId: null, action: "create", entityType: "patient", entityId: "p1" },
    });

    const res = await applyOps(makeCtx([CLINIC_A]), [ko, ok], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: ko.opId, reason: REJECT.clinicMismatch }]);
    expect(res.accepted).toEqual([ok.opId]);
  });
});

describe("applyOps — A4 conflits (LWW + protections)", () => {
  it("base-rev-mismatch → la dernière écriture gagne + ligne sync_conflict", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      firstName: "Etat serveur",
      rev: 5,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      rev: 2, // baseRev périmé
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Etat client" },
    });

    const res = await applyOps(makeCtx(), [op], LATER, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    expect(res.conflicts).toEqual([
      { table: "patient", rowId: "p1", reason: "base-rev-mismatch" },
    ]);
    // LWW : écriture quand même, rev serveur monotone.
    expect(harness.getRow("patient", "p1")).toMatchObject({
      firstName: "Etat client",
      rev: 6,
    });
    expect(harness.state.conflicts).toHaveLength(1);
    expect(harness.state.conflicts[0]).toMatchObject({
      tableName: "patient",
      rowId: "p1",
      deviceId: "device-1",
      reason: "base-rev-mismatch",
    });
    // winning = payload appliqué ; losing = état serveur préalable.
    expect(harness.state.conflicts[0]?.winningPayload).toMatchObject({
      firstName: "Etat client",
      rev: 6,
    });
    expect(harness.state.conflicts[0]?.losingPayload).toMatchObject({
      firstName: "Etat serveur",
      rev: 5,
    });
  });

  it("baseRev absente sur une ligne existante → divergence journalisée", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      rev: 2,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "update",
      payload: { id: "p1", clinicId: CLINIC_A, firstName: "Sans base" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    expect(res.conflicts[0]?.reason).toBe("base-rev-mismatch");
    expect((harness.getRow("patient", "p1") as Row).rev).toBe(3);
  });

  it("VERRO MONTANTS : facture au-delà de draft → montants intacts, reste appliqué", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", {
      id: "inv1",
      clinicId: CLINIC_A,
      status: "paid",
      subtotal: 100,
      taxTotal: 19,
      discountTotal: 0,
      total: 119,
      notes: "anciennes notes",
      rev: 3,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "invoice",
      rowId: "inv1",
      op: "update",
      rev: 3, // baseRev NON divergente : le verrou s'applique quand même
      payload: {
        id: "inv1",
        clinicId: CLINIC_A,
        status: "paid",
        subtotal: 1,
        taxTotal: 2,
        discountTotal: 3,
        total: 9999,
        notes: "nouvelles notes",
      },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    const row = harness.getRow("invoice", "inv1") as Row;
    // Montants serveur INTACTS.
    expect(row).toMatchObject({
      subtotal: 100,
      taxTotal: 19,
      discountTotal: 0,
      total: 119,
      status: "paid",
    });
    // Partie non protégée appliquée + rev serveur.
    expect(row.notes).toBe("nouvelles notes");
    expect(row.rev).toBe(4);
    // Le refus des montants est journalisé et visible côté client.
    expect(res.conflicts).toEqual([
      { table: "invoice", rowId: "inv1", reason: "protected-amounts" },
    ]);
    expect(harness.state.conflicts[0]).toMatchObject({
      reason: "protected-amounts",
      winningPayload: { subtotal: 100, taxTotal: 19, discountTotal: 0, total: 119, status: "paid" },
      losingPayload: { subtotal: 1, taxTotal: 2, discountTotal: 3, total: 9999 },
    });
  });

  it("VERRO MONTANTS : la tentative de retour à `draft` est écartée", async () => {
    const harness = createMemoryRepo();
    harness.seed("quote", "q1", {
      id: "q1",
      clinicId: CLINIC_A,
      status: "accepted",
      subtotal: 50,
      taxTotal: 0,
      discountTotal: 0,
      total: 50,
      rev: 2,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "quote",
      rowId: "q1",
      op: "update",
      rev: 2,
      payload: { id: "q1", clinicId: CLINIC_A, status: "draft", total: 1 },
    });

    await applyOps(makeCtx(), [op], NOW, harness.repo);

    const row = harness.getRow("quote", "q1") as Row;
    expect(row.status).toBe("accepted");
    expect(row.total).toBe(50);
  });

  it("VERRO MONTANTS : un document encore en `draft` reste librement modifiable", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", {
      id: "inv1",
      clinicId: CLINIC_A,
      status: "draft",
      subtotal: 100,
      taxTotal: 19,
      discountTotal: 0,
      total: 119,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "invoice",
      rowId: "inv1",
      op: "update",
      rev: 1,
      payload: {
        id: "inv1",
        clinicId: CLINIC_A,
        status: "draft",
        subtotal: 200,
        taxTotal: 38,
        discountTotal: 0,
        total: 238,
      },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.conflicts).toEqual([]);
    expect(harness.state.conflicts).toEqual([]);
    expect(harness.getRow("invoice", "inv1")).toMatchObject({
      subtotal: 200,
      total: 238,
      status: "draft",
      rev: 2,
    });
  });
});

describe("applyOps — A5 enfants (Groupe B)", () => {
  const invoiceSeed: Row = {
    id: "inv1",
    clinicId: CLINIC_A,
    status: "draft",
    rev: 1,
    updatedAt: NOW,
    deletedAt: null,
  };

  it("un enfant est écrit si et seulement si son parent existe dans la portée", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", invoiceSeed);
    const op = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "insert",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv1", description: "Extraction", total: 40 },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    expect(harness.getRow("invoice_item", "li1")).toMatchObject({
      invoiceId: "inv1",
      description: "Extraction",
    });
  });

  it("parent introuvable → parent-missing (op hors ordre, rejouable)", async () => {
    const harness = createMemoryRepo();
    const op = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "insert",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv-ghost", description: "X", total: 1 },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.parentMissing }]);
    expect(harness.getRow("invoice_item", "li1")).toBeUndefined();
    expect(harness.state.applied.size).toBe(0);
  });

  it("parent d'un AUTRE cabinet → clinic-mismatch (portée dérivée du parent)", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv-b", { ...invoiceSeed, id: "inv-b", clinicId: CLINIC_B });
    const op = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "insert",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv-b", description: "X", total: 1 },
    });

    const res = await applyOps(makeCtx([CLINIC_A]), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.clinicMismatch }]);
    expect(harness.getRow("invoice_item", "li1")).toBeUndefined();
  });

  it("un enfant ne peut pas être supprimé (pas de tombstone sur le Groupe B)", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", invoiceSeed);
    harness.seed("invoice_item", "li1", { id: "li1", invoiceId: "inv1" });
    const op = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "delete",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv1" },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([
      { opId: op.opId, reason: REJECT.childDeleteUnsupported },
    ]);
  });

  it("VERRO MONTANTS étendu : lignes refusées sur un document au-delà de draft", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", { ...invoiceSeed, status: "paid" });
    const op = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "insert",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv1", description: "Ligne saugrenue", total: 1 },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.rejected).toEqual([{ opId: op.opId, reason: REJECT.protectedDocument }]);
    expect(harness.getRow("invoice_item", "li1")).toBeUndefined();
  });
});

describe("applyOps — A6 tombstones", () => {
  it("delete → deleted_at = now (soft delete), rev + 1, ligne toujours présente", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      rev: 4,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({ table: "patient", rowId: "p1", op: "delete", payload: {} });

    const res = await applyOps(makeCtx(), [op], LATER, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    const row = harness.getRow("patient", "p1") as Row;
    expect(row.deletedAt).toEqual(LATER);
    expect(row.rev).toBe(5);
    // Le curseur de pull doit avancer : updated_at = now serveur.
    expect(row.updatedAt).toEqual(LATER);
  });

  it("delete avec baseRev périmé → tombstone + conflit journalisé", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      rev: 7,
      updatedAt: NOW,
      deletedAt: null,
    });
    const op = makeOp({
      table: "patient",
      rowId: "p1",
      op: "delete",
      rev: 1,
      payload: {},
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.conflicts).toEqual([
      { table: "patient", rowId: "p1", reason: "base-rev-mismatch" },
    ]);
    expect((harness.getRow("patient", "p1") as Row).rev).toBe(8);
  });
});

describe("applyOps — A5bis sécurité sérialisation", () => {
  it("un push `user` ne peut jamais injecter password_hash", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-1", [CLINIC_A]]]),
    });
    const op = makeOp({
      table: "user",
      rowId: "user-1",
      op: "insert",
      clinicId: null,
      payload: {
        id: "user-1",
        name: "Dr A",
        email: "a@example.com",
        passwordHash: "$2b$12$atrechoisir",
        tokenVersion: 0,
      },
    });

    const res = await applyOps(makeCtx(), [op], NOW, harness.repo);

    expect(res.accepted).toEqual([op.opId]);
    const row = harness.getRow("user", "user-1") as Row;
    expect(row).toMatchObject({ name: "Dr A", tokenVersion: 0 });
    expect(row.passwordHash).toBeUndefined();
  });

  it("un lot mêlant plusieurs opérations les applique dans l'ordre du tableau", async () => {
    const harness = createMemoryRepo();
    const parent = makeOp({
      table: "invoice",
      rowId: "inv1",
      op: "insert",
      payload: { id: "inv1", clinicId: CLINIC_A, status: "draft", subtotal: 0, total: 0 },
    });
    const child = makeOp({
      table: "invoice_item",
      rowId: "li1",
      op: "insert",
      clinicId: null,
      payload: { id: "li1", invoiceId: "inv1", description: "Soin", total: 30 },
    });

    const res = await applyOps(makeCtx(), [parent, child], NOW, harness.repo);

    expect(res.accepted).toEqual([parent.opId, child.opId]);
    expect(harness.getRow("invoice_item", "li1")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. fetchChanges — règles B1 à B6                                            */
/* -------------------------------------------------------------------------- */

describe("fetchChanges — portée B2 (anti-IDOR)", () => {
  it("SyncScopeError si req.clinicId hors ctx.clinicIds", async () => {
    const { repo } = createMemoryRepo();

    await expect(
      fetchChanges(makeCtx([CLINIC_A]), pullRequest({ clinicId: CLINIC_B }), NOW, repo),
    ).rejects.toBeInstanceOf(SyncScopeError);
  });

  it("deux cabinets : jamais UNE ligne de l'autre, même si le repo les renvoie", async () => {
    const harness = createMemoryRepo();
    // Le repo est naïf : il renvoie tout. La couche pure doit filtrer.
    harness.seed("patient", "p-a", {
      id: "p-a",
      clinicId: CLINIC_A,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("patient", "p-b", {
      id: "p-b",
      clinicId: CLINIC_B,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("clinic", CLINIC_A, {
      id: CLINIC_A,
      name: "A",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("clinic", CLINIC_B, {
      id: CLINIC_B,
      name: "B",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx([CLINIC_A]),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    const tables = res.changes.map((c) => c.table);
    expect(tables).toContain("patient");
    expect(tables).toContain("clinic");
    for (const change of res.changes) {
      if (change.table === "patient") expect(change.rowId).toBe("p-a");
      if (change.table === "clinic") expect(change.rowId).toBe(CLINIC_A);
      expect(change.rowId).not.toBe("p-b");
      expect(change.rowId).not.toBe(CLINIC_B);
    }
  });

  it("table `user` : seuls les membres du cabinet tiré sont renvoyés", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([
        ["user-membre", [CLINIC_A]],
        ["user-autre", [CLINIC_B]],
      ]),
    });
    harness.seed("user", "user-membre", {
      id: "user-membre",
      name: "Dr A",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("user", "user-autre", {
      id: "user-autre",
      name: "Dr B",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx([CLINIC_A]),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    const userIds = res.changes.filter((c) => c.table === "user").map((c) => c.rowId);
    expect(userIds).toEqual(["user-membre"]);
  });
});

describe("fetchChanges — B6 sécurité sérialisation", () => {
  it("un tirage `user` ne contient JAMAIS password_hash", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-1", [CLINIC_A]]]),
    });
    // Le repo naïf renvoie la ligne BRUTE, secrets compris.
    harness.seed("user", "user-1", {
      id: "user-1",
      name: "Dr A",
      email: "a@example.com",
      passwordHash: "$2b$12$secret",
      tokenVersion: 2,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    const userOp = res.changes.find((c) => c.table === "user");
    expect(userOp).toBeDefined();
    expect(Object.keys(userOp?.payload ?? {})).not.toContain("passwordHash");
    expect(JSON.stringify(userOp?.payload)).not.toContain("password_hash");
    expect(userOp?.payload).toMatchObject({ name: "Dr A", tokenVersion: 2 });
    // Régression : SANS option, AUCUNE trace de hash (ni clé, ni valeur) dans
    // l'intégralité de la réponse — y compris les autres tables.
    expect(JSON.stringify(res)).not.toContain("$2b$12$secret");
    expect(JSON.stringify(res)).not.toContain("passwordHash");
  });
});

/* -------------------------------------------------------------------------- */
/* 3bis. Variante « bootstrap » (tâche 7.1b) — includeAuthBootstrap            */
/* -------------------------------------------------------------------------- */

/** Forme bcrypt stricte attendue par `extractUserPasswordHashes` : 60 car. */
const BOOTSTRAP_HASH = `$2b$12$${"a".repeat(53)}`;

describe("fetchChanges — variante bootstrap (includeAuthBootstrap)", () => {
  it("par défaut (sans option) : JAMAIS de hash, même si la ligne brute en porte un", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-1", [CLINIC_A]]]),
    });
    harness.seed("user", "user-1", {
      id: "user-1",
      name: "Dr A",
      passwordHash: BOOTSTRAP_HASH,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    expect(JSON.stringify(res)).not.toContain(BOOTSTRAP_HASH);
    expect(JSON.stringify(res)).not.toContain("passwordHash");
  });

  it("avec l'option : hash émis sur `user` VIVANT, forme bcrypt 60 car., colonnes = liste blanche + hash", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-1", [CLINIC_A]]]),
    });
    harness.seed("user", "user-1", {
      id: "user-1",
      name: "Dr A",
      email: "a@example.com",
      tokenVersion: 2,
      passwordHash: BOOTSTRAP_HASH,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
      { includeAuthBootstrap: true },
    );

    const userOp = res.changes.find((c) => c.table === "user");
    expect(userOp).toBeDefined();
    expect(userOp?.op).toBe("insert");
    expect(userOp?.payload.passwordHash).toBe(BOOTSTRAP_HASH);
    expect(String(userOp?.payload.passwordHash)).toHaveLength(60);
    expect(String(userOp?.payload.passwordHash)).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);

    // La liste blanche reste la base : hash EN PLUS, et JAMAIS une colonne en
    // dehors de `TABLE_REGISTRY.user.columns` (+ `passwordHash` seul ajout).
    const userWhitelist = new Set<string>([
      ...TABLE_REGISTRY.user.columns,
      "passwordHash",
    ]);
    for (const key of Object.keys(userOp?.payload ?? {})) {
      expect(userWhitelist.has(key), `colonne hors périmètre : ${key}`).toBe(true);
    }
    // Les 4 colonnes de profil présentes sur la ligne + exactement le hash.
    expect(Object.keys(userOp?.payload ?? {}).sort()).toEqual(
      ["id", "name", "email", "tokenVersion", "passwordHash"].sort(),
    );
    // Le registre n'a PAS été modifié (protocol.ts intact).
    expect(TABLE_REGISTRY.user.columns).not.toContain("passwordHash");
    expect(userOp?.payload).toMatchObject({ name: "Dr A", email: "a@example.com", tokenVersion: 2 });
  });

  it("avec l'option : JAMAIS de hash sur un tombstone `user` (ligne supprimée)", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-1", [CLINIC_A]]]),
    });
    harness.seed("user", "user-1", {
      id: "user-1",
      name: "Dr A",
      passwordHash: BOOTSTRAP_HASH,
      rev: 2,
      updatedAt: LATER,
      deletedAt: LATER,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
      { includeAuthBootstrap: true },
    );

    const userOp = res.changes.find((c) => c.table === "user");
    expect(userOp?.op).toBe("delete");
    expect(Object.keys(userOp?.payload ?? {})).not.toContain("passwordHash");
    expect(JSON.stringify(res)).not.toContain(BOOTSTRAP_HASH);
  });

  it("avec l'option : les AUTRES tables sont strictement inchangées (liste blanche seule)", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([
        ["user-1", [CLINIC_A]],
        ["user-2", [CLINIC_A]],
      ]),
    });
    // Membre vivant, membre supprimé, patient, cabinet : même tirage.
    harness.seed("user", "user-1", {
      id: "user-1",
      name: "Dr A",
      passwordHash: BOOTSTRAP_HASH,
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("user", "user-2", {
      id: "user-2",
      name: "Dr B",
      passwordHash: BOOTSTRAP_HASH,
      rev: 2,
      updatedAt: LATER,
      deletedAt: LATER,
    });
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      firstName: "Zoé",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("clinic", CLINIC_A, {
      id: CLINIC_A,
      name: "Cabinet A",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
      { includeAuthBootstrap: true },
    );

    // (a) Hash EXCLUSIVEMENT sur l'op `user` vivante (ligne `user-2` = delete).
    const withHash = res.changes.filter(
      (c) => c.table === "user" && c.op !== "delete",
    );
    expect(withHash).toHaveLength(1);
    expect(withHash[0]?.rowId).toBe("user-1");
    expect(withHash[0]?.payload.passwordHash).toBe(BOOTSTRAP_HASH);

    // (b) Aucune autre table ne porte le hash (ni sa clé, ni sa valeur), et
    //     chaque payload reste STRICTEMENT dans la liste blanche de sa table.
    for (const change of res.changes) {
      if (change.table === "user") continue;
      const whitelist = new Set<string>(TABLE_REGISTRY[change.table]?.columns ?? []);
      expect(Object.keys(change.payload)).not.toContain("passwordHash");
      expect(JSON.stringify(change.payload)).not.toContain(BOOTSTRAP_HASH);
      for (const key of Object.keys(change.payload)) {
        expect(whitelist.has(key), `${change.table}.${key} hors liste blanche`).toBe(true);
      }
    }

    // (c) Le tombstone `user` non plus.
    const deletedUser = res.changes.find((c) => c.table === "user" && c.op === "delete");
    expect(deletedUser?.rowId).toBe("user-2");
    expect(JSON.stringify(deletedUser?.payload)).not.toContain(BOOTSTRAP_HASH);
  });

  it("avec l'option : une ligne `user` sans hash dans la base n'en reçoit aucun", async () => {
    const harness = createMemoryRepo({
      memberships: new Map([["user-sans", [CLINIC_A]]]),
    });
    harness.seed("user", "user-sans", {
      id: "user-sans",
      name: "Dr C",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
      { includeAuthBootstrap: true },
    );

    const userOp = res.changes.find((c) => c.table === "user");
    expect(Object.keys(userOp?.payload ?? {})).not.toContain("passwordHash");
  });
});

describe("fetchChanges — B1/B5 curseur composite et pagination", () => {
  function seedPatients(harness: MemoryHarness, count: number, base: Date): void {
    for (let i = 0; i < count; i += 1) {
      const id = `p-${String(i).padStart(2, "0")}`;
      harness.seed("patient", id, {
        id,
        clinicId: CLINIC_A,
        firstName: `Patient ${i}`,
        rev: 1,
        // Toutes les lignes partagent la MÊME millisseconde : le tie-break
        // est porté par `id` (règle B1).
        updatedAt: base,
        deletedAt: null,
      });
    }
  }

  it("pagination : hasMore exact et progression stable du curseur", async () => {
    const harness = createMemoryRepo();
    seedPatients(harness, 5, NOW);

    const first = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A, limit: 2 }),
      NOW,
      harness.repo,
    );
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toEqual({ updatedAt: NOW.toISOString(), id: "p-01" });

    const second = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A, cursor: first.cursor, limit: 2 }),
      NOW,
      harness.repo,
    );
    expect(second.changes.map((c) => c.rowId)).toEqual(["p-02", "p-03"]);
    expect(second.hasMore).toBe(true);

    const third = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A, cursor: second.cursor, limit: 2 }),
      NOW,
      harness.repo,
    );
    expect(third.changes.map((c) => c.rowId)).toEqual(["p-04"]);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toEqual({ updatedAt: NOW.toISOString(), id: "p-04" });

    // Aucune ligne restante : curseur STABLE (aucun saut, aucune boucle).
    const fourth = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A, cursor: third.cursor, limit: 2 }),
      NOW,
      harness.repo,
    );
    expect(fourth.changes).toEqual([]);
    expect(fourth.hasMore).toBe(false);
    expect(fourth.cursor).toEqual(third.cursor);
  });

  it("premier tirage sans donnée → MIN_PULL_CURSOR, hasMore false", async () => {
    const { repo } = createMemoryRepo();

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      repo,
    );

    expect(res.changes).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.cursor).toEqual(MIN_PULL_CURSOR);
  });

  it("deux lignes dans la MÊME millisseconde ne sautent jamais (tie-break id)", async () => {
    const harness = createMemoryRepo();
    seedPatients(harness, 3, NOW);

    // Tirage unitaire : l'ordre impose p-00 puis p-01 puis p-02.
    let cursor: { updatedAt: string; id: string } | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const page = await fetchChanges(
        makeCtx(),
        pullRequest({ clinicId: CLINIC_A, cursor, limit: 1 }),
        NOW,
        harness.repo,
      );
      seen.push(...page.changes.map((c) => c.rowId));
      cursor = page.cursor;
    }
    expect(seen).toEqual(["p-00", "p-01", "p-02"]);
  });

  it("les tombstones sont tirés en op `delete`", async () => {
    const harness = createMemoryRepo();
    harness.seed("patient", "p1", {
      id: "p1",
      clinicId: CLINIC_A,
      rev: 2,
      updatedAt: NOW,
      deletedAt: LATER,
    });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({
      table: "patient",
      rowId: "p1",
      op: "delete",
      rev: 2,
    });
    expect(res.changes[0]?.payload.deletedAt).toBeDefined();
  });

  it("limit nul ou négatif est borné à 1 (garde défensive)", async () => {
    const harness = createMemoryRepo();
    seedPatients(harness, 3, NOW);

    const res = await fetchChanges(
      makeCtx(),
      // Le schéma Zod de la route refuse déjà cela ; la couche pure reste ferme.
      pullRequest({ clinicId: CLINIC_A, limit: 0 }),
      NOW,
      harness.repo,
    );

    expect(res.changes).toHaveLength(1);
    expect(res.hasMore).toBe(true);
  });
});

describe("fetchChanges — B4 enfants en cascadé", () => {
  it("chaque parent vivant transporte ses lignes, hors du `limit`", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", {
      id: "inv1",
      clinicId: CLINIC_A,
      status: "draft",
      rev: 1,
      updatedAt: NOW,
      deletedAt: null,
    });
    harness.seed("invoice_item", "li1", { id: "li1", invoiceId: "inv1", description: "A", total: 10 });
    harness.seed("invoice_item", "li2", { id: "li2", invoiceId: "inv1", description: "B", total: 20 });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    const parent = res.changes.filter((c) => c.table === "invoice");
    const children = res.changes.filter((c) => c.table === "invoice_item");
    expect(parent).toHaveLength(1);
    expect(children.map((c) => c.rowId).sort()).toEqual(["li1", "li2"]);
    // Les enfants portent la portée de leur parent et son horodatage.
    for (const child of children) {
      expect(child.clinicId).toBe(CLINIC_A);
      expect(child.op).toBe("insert");
      expect(child.updatedAt).toBe(NOW.toISOString());
    }
  });

  it("un parent tombstone ne transporte AUCUN enfant", async () => {
    const harness = createMemoryRepo();
    harness.seed("invoice", "inv1", {
      id: "inv1",
      clinicId: CLINIC_A,
      status: "draft",
      rev: 1,
      updatedAt: NOW,
      deletedAt: LATER,
    });
    harness.seed("invoice_item", "li1", { id: "li1", invoiceId: "inv1", description: "A", total: 10 });

    const res = await fetchChanges(
      makeCtx(),
      pullRequest({ clinicId: CLINIC_A }),
      NOW,
      harness.repo,
    );

    expect(res.changes.map((c) => c.table)).toEqual(["invoice"]);
    expect(res.changes[0]?.op).toBe("delete");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Helpers purs                                                             */
/* -------------------------------------------------------------------------- */

describe("pullScopeOf / rowWithinScope", () => {
  it("dérive la portée à partir du registre", () => {
    expect(pullScopeOf("clinic", [CLINIC_A])).toEqual({ kind: "clinic-ids", ids: [CLINIC_A] });
    expect(pullScopeOf("user", [CLINIC_A])).toEqual({
      kind: "user-membership",
      clinicIds: [CLINIC_A],
    });
    expect(pullScopeOf("patient", [CLINIC_A])).toEqual({
      kind: "clinic-column",
      column: "clinicId",
      clinicIds: [CLINIC_A],
    });
    expect(pullScopeOf("audit_log", [CLINIC_A])).toBeNull();
    expect(pullScopeOf("table-inconnue", [CLINIC_A])).toBeNull();
  });

  it("rowWithinScope rejette toute ligne hors portée", () => {
    const clinicIds = [CLINIC_A];
    const members = new Set(["u1"]); // user ids membres du cabinet A
    const clinicScope: PullScope = { kind: "clinic-column", column: "clinicId", clinicIds };
    expect(rowWithinScope("patient", { id: "p", clinicId: CLINIC_A }, clinicScope, members)).toBe(true);
    expect(rowWithinScope("patient", { id: "p", clinicId: CLINIC_B }, clinicScope, members)).toBe(false);
    expect(rowWithinScope("patient", { id: "p", clinicId: null }, clinicScope, members)).toBe(false);

    const idsScope: PullScope = { kind: "clinic-ids", ids: [CLINIC_A] };
    expect(rowWithinScope("clinic", { id: CLINIC_A }, idsScope, members)).toBe(true);
    expect(rowWithinScope("clinic", { id: CLINIC_B }, idsScope, members)).toBe(false);

    const userScope: PullScope = { kind: "user-membership", clinicIds: [CLINIC_A] };
    expect(rowWithinScope("user", { id: "u1" }, userScope, members)).toBe(true);
    expect(rowWithinScope("user", { id: "u2" }, userScope, members)).toBe(false);
  });
});

describe("erreurs contractuelles", () => {
  it("RejectedOpError porte sa raison", () => {
    const error = new RejectedOpError(REJECT.parentMissing);
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe(REJECT.parentMissing);
    expect(error.message).toContain(REJECT.parentMissing);
  });

  it("applyOps refuse une horloge serveur caduque", async () => {
    const { repo } = createMemoryRepo();
    await expect(
      applyOps(makeCtx(), [], new Date(NaN), repo),
    ).rejects.toThrow(/horloge serveur caduque/);
  });

  it("applyOps refuse un lot au-delà de MAX_PUSH_OPS", async () => {
    const { repo } = createMemoryRepo();
    const ops = Array.from({ length: 101 }, () =>
      makeOp({ table: "patient", rowId: "p1", op: "insert" }),
    );
    await expect(applyOps(makeCtx(), ops, NOW, repo)).rejects.toThrow(/max 100/);
  });

  it("un lot vide est accepté sans requête inutile", async () => {
    const { repo } = createMemoryRepo();
    const res = await applyOps(makeCtx(), [], NOW, repo);
    expect(res).toEqual({ accepted: [], rejected: [], conflicts: [] });
  });
});
