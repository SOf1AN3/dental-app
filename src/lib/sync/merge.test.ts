import { describe, expect, it } from "vitest";
import {
  MERGE_CHAIN_MAX_HOPS,
  MERGE_REVIEW_PREFIX,
  PATIENT_CHILD_TABLES,
  chooseCanonical,
  evaluateDuplicate,
  listPendingMerges,
  mergeDuplicatePatients,
  resolveMerge,
  type MergeRecord,
  type MergeRepo,
  type MergeResult,
  type MergeTx,
  type NewMergeRecord,
  type PatientCandidate,
} from "./merge";
import {
  recordPushConflicts,
  type ConflictFilter,
  type ConflictRepo,
  type ConflictRow,
  type NewConflictRow,
} from "./conflict";

/**
 * Tests **hermétiques** de la fusion des doublons patients (D-5) — tâche 6.2.
 *
 * Aucune base (repo mémoire, transactions simulées par snapshot/rollback),
 * aucune horloge réelle (`now` injecté). Couverture exigée :
 *  - `evaluateDuplicate` : `id` + garde-fou → `merge` ; `id` identique mais
 *    naissance différente → `review` ; e-mail identique mais nom différent →
 *    `review` ; **téléphone seul → jamais `merge`** ;
 *  - **correctif 1** : cabinets différents **ou** `clinicId` absent → `review`
 *    (`cross-clinic`), **jamais** `merge` (multi-tenant) ;
 *  - `mergeDuplicatePatients` : transaction **intégrale** (rollback sur
 *    échec), réorientation des enfants, tombstone, trace `sync_merge`,
 *    **2ᵉ appel idempotent** (index unique) ;
 *  - **correctif 2** : chaînage A→B, B→C → point fixe **C** ; cycle A→B→A et
 *    chaîne > borne → `review` (aucune boucle infinie) ;
 *  - **correctif 3** : conflit push D-4 et revue de fusion sur le **même**
 *    patient coexistent (clé `rowId` namespacée `merge-review:`) ;
 *  - **correctif 4** : outbox `pending` du doublon **traitée**, celle du
 *    canonique **intacte**, purge annulée par le rollback ;
 *  - file de revue : `listPendingMerges` / `resolveMerge`.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = new Date("2026-06-01T12:00:00.000Z");
const CLINIC = "clinic-1";
const DOB = new Date("1990-04-12T00:00:00.000Z");

function makeCandidate(overrides: Partial<PatientCandidate> & { id: string }): PatientCandidate {
  return {
    clinicId: CLINIC,
    firstName: "Amina",
    lastName: "Bensalem",
    dateOfBirth: DOB,
    email: "amina@example.dz",
    phone: "+213 555 000 111",
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Repo mémoire (transaction par snapshot → rollback réel)                     */
/* -------------------------------------------------------------------------- */

interface FakePatientRow extends PatientCandidate {
  deletedAt: Date | null;
}

interface FakeChild {
  table: string;
  id: string;
  patientId: string;
}

/** Ligne `sync_outbox` simulée (correctif 4 : purge des `pending` du doublon). */
interface FakeOutboxRow {
  id: string;
  table: string;
  rowId: string;
  status: "pending" | "sent" | "failed";
}

interface FakeState {
  patients: Map<string, FakePatientRow>;
  /** Clé = `duplicate_id` (index unique). */
  merges: Map<string, MergeRecord>;
  children: FakeChild[];
  conflicts: ConflictRow[];
  outbox: FakeOutboxRow[];
  /** Déclencheur d'échec injecté sur `insertMerge` (test de rollback). */
  failInsertMerge: boolean;
}

function createState(): FakeState {
  return {
    patients: new Map(),
    merges: new Map(),
    children: [],
    conflicts: [],
    outbox: [],
    failInsertMerge: false,
  };
}

function snapshot(state: FakeState) {
  return {
    patients: new Map([...state.patients].map(([key, row]) => [key, { ...row }])),
    merges: new Map([...state.merges].map(([key, row]) => [key, { ...row }])),
    children: state.children.map((child) => ({ ...child })),
    conflicts: state.conflicts.map((row) => ({ ...row })),
    outbox: state.outbox.map((row) => ({ ...row })),
    failInsertMerge: state.failInsertMerge,
  };
}

function restore(state: FakeState, snap: ReturnType<typeof snapshot>): void {
  state.patients = snap.patients;
  state.merges = snap.merges;
  state.children = snap.children;
  state.conflicts = snap.conflicts;
  state.outbox = snap.outbox;
  state.failInsertMerge = snap.failInsertMerge;
}

function createFakeConflictRepo(state: FakeState): ConflictRepo {
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

  return {
    async findRecent(table, rowId, limit = 50) {
      return state.conflicts
        .filter((row) => row.table === table && row.rowId === rowId)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async insert(row: NewConflictRow) {
      state.conflicts.push({
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
      return state.conflicts
        .filter((row) => matches(row, filter))
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
        .slice(0, filter.limit ?? 200)
        .map((row) => ({ ...row }));
    },
    async resolve(id, resolvedBy, at) {
      const row = state.conflicts.find((entry) => entry.id === id);
      if (row === undefined || row.resolvedAt !== null) return;
      row.resolvedBy = resolvedBy;
      row.resolvedAt = at;
    },
  };
}

function createFakeTx(state: FakeState): MergeTx {
  return {
    async getPatient(id) {
      const row = state.patients.get(id);
      return row === undefined ? null : { ...row };
    },
    async getMerge(duplicateId) {
      const row = state.merges.get(duplicateId);
      return row === undefined ? null : { ...row };
    },
    async insertMerge(record: NewMergeRecord) {
      if (state.failInsertMerge) {
        throw new Error("échec injecté : écriture sync_merge");
      }
      // L'index unique `uq_sync_merge_duplicate_id` rend l'insertion idempotente.
      if (state.merges.has(record.duplicateId)) return;
      state.merges.set(record.duplicateId, { ...record });
    },
    async repointChildren(fromId, toId) {
      const byTable: Record<string, number> = {};
      let total = 0;
      for (const child of state.children) {
        if (child.patientId !== fromId) continue;
        byTable[child.table] = (byTable[child.table] ?? 0) + 1;
        child.patientId = toId;
        total += 1;
      }
      return { total, byTable };
    },
    async tombstonePatient(id, at) {
      const row = state.patients.get(id);
      if (row !== undefined) row.deletedAt = at;
    },
    // Correctif 4 : seules les lignes `pending` de (table, rowId) passent à
    // `sent` — exactement le contrat du repo Drizzle.
    async purgeOutboxFor(table, rowId) {
      for (const row of state.outbox) {
        if (row.table === table && row.rowId === rowId && row.status === "pending") {
          row.status = "sent";
        }
      }
    },
    conflicts: createFakeConflictRepo(state),
  };
}

/** Repo dont **chaque** opération passe par une transaction snapshot/rollback. */
function createFakeRepo(state: FakeState): MergeRepo {
  return {
    async transaction(fn) {
      const snap = snapshot(state);
      try {
        return await fn(createFakeTx(state));
      } catch (error) {
        restore(state, snap);
        throw error;
      }
    },
  };
}

function addPatient(state: FakeState, candidate: PatientCandidate): void {
  state.patients.set(candidate.id, { ...candidate, deletedAt: null });
}

/** Dossier « dupliqué » : même identité, `id` différent (poste hors-ligne). */
function seedPair(
  state: FakeState,
  options: {
    canonical?: Partial<PatientCandidate>;
    duplicate?: Partial<PatientCandidate>;
  } = {},
): { canonical: PatientCandidate; duplicate: PatientCandidate } {
  const canonical = makeCandidate({
    id: "p-canonical",
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    ...options.canonical,
  });
  const duplicate = makeCandidate({
    id: "p-duplicate",
    createdAt: new Date("2026-05-03T09:00:00.000Z"),
    ...options.duplicate,
  });
  addPatient(state, canonical);
  addPatient(state, duplicate);
  return { canonical, duplicate };
}

function expectStatus<T extends MergeResult["status"]>(
  result: MergeResult,
  status: T,
): Extract<MergeResult, { status: T }> {
  if (result.status !== status) {
    throw new Error(`statut inattendu « ${result.status} » (« ${status} » attendu)`);
  }
  // Contrôle ci-dessus : le statut prouvé est celui demandé, le union member
  // correspondant est donc la seule branche possible.
  return result as Extract<MergeResult, { status: T }>;
}

/* -------------------------------------------------------------------------- */
/* 1. evaluateDuplicate — décision pure D-5                                    */
/* -------------------------------------------------------------------------- */

describe("evaluateDuplicate — identifiants natifs et garde-fou (D-5)", () => {
  it("UUID + nom/prénom/naissance identiques → merge", () => {
    const existing = makeCandidate({ id: "p-same" });
    const candidate = makeCandidate({ id: "p-same" });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("merge");
    if (decision.action !== "merge") return;
    expect(decision.canonicalId).toBe("p-same");
    expect(decision.duplicateId).toBe("p-same");
    expect(decision.reason).toContain("d5-id");
  });

  it("UUID identique mais date de naissance DIFFÉRENTE → review (jamais fusion)", () => {
    const existing = makeCandidate({ id: "p-same" });
    const candidate = makeCandidate({ id: "p-same", dateOfBirth: new Date("1991-04-12T00:00:00.000Z") });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toContain("naissance");
  });

  it("e-mail identique mais nom différent → review", () => {
    const existing = makeCandidate({ id: "p-1" });
    const candidate = makeCandidate({ id: "p-2", firstName: "Karim" });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toContain("nom ou prénom");
  });

  it("téléphone SEUL (même nom/naissance) → jamais merge : action `none`", () => {
    const existing = makeCandidate({ id: "p-1", email: "un@exemple.dz" });
    const candidate = makeCandidate({ id: "p-2", email: "deux@exemple.dz" });
    // Même téléphone, même nom, même naissance : deux personnes peuvent tout
    // à fait en partager un — le téléphone n'est JAMAIS un identifiant.
    expect(candidate.phone).toBe(existing.phone);

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("none");
    if (decision.action !== "none") return;
    expect(decision.reason).toContain("téléphone");
  });

  it("téléphone identique + e-mail identique mais prénom différent → review", () => {
    const existing = makeCandidate({ id: "p-1" });
    const candidate = makeCandidate({ id: "p-2", firstName: "  aMiNa  " });
    const sameEmail = makeCandidate({ id: "p-3", firstName: "Selma" });

    expect(evaluateDuplicate(candidate, existing, T0).action).toBe("merge");
    expect(evaluateDuplicate(sameEmail, existing, T0).action).toBe("review");
  });

  it("e-mail identique + garde-fou respecté → merge vers le plus ancien `created_at`", () => {
    const older = makeCandidate({ id: "p-older", createdAt: new Date("2026-04-01T08:00:00.000Z") });
    const newer = makeCandidate({ id: "p-newer", createdAt: new Date("2026-05-20T08:00:00.000Z") });

    const decision = evaluateDuplicate(newer, older, T0);

    expect(decision).toMatchObject({
      action: "merge",
      canonicalId: "p-older",
      duplicateId: "p-newer",
    });
    if (decision.action !== "merge") return;
    expect(decision.reason).toContain("d5-email");
  });

  it("date de naissance absente → review (échec fermé, jamais de fusion à l'aveugle)", () => {
    const existing = makeCandidate({ id: "p-1", dateOfBirth: null });
    const candidate = makeCandidate({ id: "p-1", dateOfBirth: null });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toContain("absente");
  });

  it("casse et espaces ignorés dans l'identité → merge", () => {
    const existing = makeCandidate({ id: "p-1", firstName: "Amina", lastName: "Bensalem" });
    const candidate = makeCandidate({
      id: "p-2",
      firstName: "  aMINA ",
      lastName: "BENSALEM\t",
    });

    expect(evaluateDuplicate(candidate, existing, T0).action).toBe("merge");
  });

  /* Correctif 1 — garde-fou MULTI-CABINET (le plus important). */

  it("homonymes, même naissance, MÊME identifiant mais cabinets DIFFÉRENTS → review `cross-clinic`", () => {
    const existing = makeCandidate({ id: "p-same", clinicId: "clinic-alpha" });
    const candidate = makeCandidate({ id: "p-same", clinicId: "clinic-beta" });

    const decision = evaluateDuplicate(candidate, existing, T0);

    // Tout le reste est identique (id, nom, naissance, e-mail) : sans le
    // garde-fou, ces deux patients de cabinets distincts seraient FUSIONNÉS.
    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toBe("cross-clinic");
  });

  it("e-mail commun + cabinets différents → jamais `merge` (échec fermé)", () => {
    const existing = makeCandidate({ id: "p-1", clinicId: "clinic-alpha" });
    const candidate = makeCandidate({ id: "p-2", clinicId: "clinic-beta" });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toBe("cross-clinic");
  });

  it("clinicId ABSENT d'un côté → review (échec fermé, jamais « même cabinet »)", () => {
    const existing = makeCandidate({ id: "p-same", clinicId: "clinic-alpha" });

    for (const absent of [null, "", "   "]) {
      const candidate = makeCandidate({ id: "p-same", clinicId: absent });
      const decision = evaluateDuplicate(candidate, existing, T0);
      expect(decision.action).toBe("review");
      if (decision.action !== "review") continue;
      expect(decision.reason).toBe("cross-clinic");
    }

    // Symétrique : c'est le côté EXISTANT qui manque de cabinet.
    const orphan = makeCandidate({ id: "p-same", clinicId: null });
    const kept = makeCandidate({ id: "p-same", clinicId: "clinic-alpha" });
    expect(evaluateDuplicate(orphan, kept, T0)).toEqual({
      action: "review",
      reason: "cross-clinic",
    });
  });

  it("le garde-fou multi-cabinet s'applique AVANT l'identifiant natif", () => {
    const existing = makeCandidate({ id: "p-1", email: "a@exemple.dz", clinicId: "clinic-alpha" });
    const candidate = makeCandidate({ id: "p-2", email: "b@exemple.dz", clinicId: "clinic-beta" });

    // Aucun identifiant commun (→ `none` en temps normal) : la frontière de
    // tenant prime et reste vérifiable côté revue.
    expect(evaluateDuplicate(candidate, existing, T0)).toEqual({
      action: "review",
      reason: "cross-clinic",
    });
  });

  it("ligne créée dans le futur (horloge de poste fausse) → review", () => {
    const existing = makeCandidate({ id: "p-1", createdAt: new Date("2026-07-01T00:00:00.000Z") });
    const candidate = makeCandidate({ id: "p-2" });

    const decision = evaluateDuplicate(candidate, existing, T0);

    expect(decision.action).toBe("review");
    if (decision.action !== "review") return;
    expect(decision.reason).toContain("horloge");
  });

  it("horloge caduque → throw (contrat « now injecté »)", () => {
    const a = makeCandidate({ id: "p-1" });
    const b = makeCandidate({ id: "p-2" });
    expect(() => evaluateDuplicate(a, b, new Date(Number.NaN))).toThrow(/caduque/);
  });
});

describe("chooseCanonical — règle du plus ancien", () => {
  it("retient la ligne la plus ancienne, puis le plus petit `id` à égalité", () => {
    const old = makeCandidate({ id: "z-old", createdAt: new Date("2026-04-01T00:00:00.000Z") });
    const young = makeCandidate({ id: "a-young", createdAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(chooseCanonical(young, old).id).toBe("z-old");

    const sameTimeA = makeCandidate({ id: "b-twin", createdAt: new Date("2026-05-01T00:00:00.000Z") });
    const sameTimeB = makeCandidate({ id: "a-twin", createdAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(chooseCanonical(sameTimeA, sameTimeB).id).toBe("a-twin");
    expect(chooseCanonical(sameTimeB, sameTimeA).id).toBe("a-twin");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. mergeDuplicatePatients — transaction, enfants, tombstone, idempotence    */
/* -------------------------------------------------------------------------- */

describe("mergeDuplicatePatients — fusion D-5 transactionnelle", () => {
  it("réoriente les enfants, pose le tombstone et écrit `sync_merge`", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    state.children.push(
      { table: "appointment", id: "ap-1", patientId: duplicate.id },
      { table: "appointment", id: "ap-2", patientId: duplicate.id },
      { table: "invoice", id: "in-1", patientId: duplicate.id },
      { table: "radiograph", id: "rx-1", patientId: canonical.id },
      { table: "clinical_session", id: "cs-1", patientId: duplicate.id },
    );

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const merged = expectStatus(result, "merged");
    expect(merged.canonicalId).toBe(canonical.id);
    expect(merged.duplicateId).toBe(duplicate.id);
    expect(merged.reason).toContain("d5-");
    // Enfants réorientés (le déjà-canonique est laissé tel quel).
    expect(merged.children.total).toBe(4);
    expect(merged.children.byTable).toEqual({
      appointment: 2,
      invoice: 1,
      clinical_session: 1,
    });
    expect(state.children.map((child) => child.patientId)).toEqual([
      canonical.id,
      canonical.id,
      canonical.id,
      canonical.id,
      canonical.id,
    ]);
    // Tombstone posé sur le doublon uniquement.
    expect(state.patients.get(duplicate.id)?.deletedAt).toEqual(T0);
    expect(state.patients.get(canonical.id)?.deletedAt).toBeNull();
    // Trace `sync_merge` (clé = duplicate_id).
    expect(state.merges.size).toBe(1);
    expect(state.merges.get(duplicate.id)).toMatchObject({
      canonicalId: canonical.id,
      duplicateId: duplicate.id,
      mergedAt: T0,
    });
    expect(state.merges.get(duplicate.id)?.id).toBe(merged.mergeId);
    expect(state.merges.get(duplicate.id)?.reason).toContain("d5-");
    // Rien n'est poussé : aucun conflit journalisé sur une fusion acceptée.
    expect(state.conflicts).toHaveLength(0);
  });

  it("2ᵉ appel identique → `already-merged`, aucune réécriture (index unique)", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    state.children.push({ table: "appointment", id: "ap-1", patientId: duplicate.id });
    const repo = createFakeRepo(state);

    const first = expectStatus(
      await mergeDuplicatePatients(repo, {
        candidateId: duplicate.id,
        existingId: canonical.id,
        now: T0,
      }),
      "merged",
    );
    const second = await mergeDuplicatePatients(repo, {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    expectStatus(second, "already-merged");
    expect(second).toMatchObject({ canonicalId: canonical.id, duplicateId: duplicate.id });
    // Une seule trace, un seul tombstone, les enfants toujours pointés vers le canonique.
    expect(state.merges.size).toBe(1);
    expect(state.merges.get(duplicate.id)?.id).toBe(first.mergeId);
    expect(state.children[0]?.patientId).toBe(canonical.id);
    expect(state.patients.get(duplicate.id)?.deletedAt).toEqual(T0);
  });

  it("échec d'écriture en cours de fusion → rollback INTÉGRAL (rien de partiel)", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    state.children.push({ table: "appointment", id: "ap-1", patientId: duplicate.id });
    state.outbox.push({
      id: "op-1",
      table: "patient",
      rowId: duplicate.id,
      status: "pending",
    });
    state.failInsertMerge = true;

    await expect(
      mergeDuplicatePatients(createFakeRepo(state), {
        candidateId: duplicate.id,
        existingId: canonical.id,
        now: T0,
      }),
    ).rejects.toThrow(/sync_merge/);

    // Ni réorientation, ni tombstone, ni trace, ni purge d'outbox : la
    // transaction a tout annulé (la purge est bien DANS cette transaction).
    expect(state.children[0]?.patientId).toBe(duplicate.id);
    expect(state.patients.get(duplicate.id)?.deletedAt).toBeNull();
    expect(state.merges.size).toBe(0);
    expect(state.conflicts).toHaveLength(0);
    expect(state.outbox[0]?.status).toBe("pending");
  });

  it("garde-fou en échec → `review` + entrée de revue, AUCUNE écriture de fusion", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state, {
      duplicate: { dateOfBirth: new Date("1975-11-03T00:00:00.000Z") },
    });
    state.children.push({ table: "appointment", id: "ap-1", patientId: duplicate.id });

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const review = expectStatus(result, "review");
    expect(review.reason).toContain("naissance");
    expect(review.reviewId.length).toBeGreaterThan(0);
    expect(state.merges.size).toBe(0);
    expect(state.patients.get(duplicate.id)?.deletedAt).toBeNull();
    expect(state.children[0]?.patientId).toBe(duplicate.id);
    // La revue est bien journalisée dans `sync_conflict` (file D-4), sous une
    // clé `rowId` namespacée (correctif 3) : elle ne peut pas entrer en
    // collision avec un conflit push du même patient.
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({
      id: review.reviewId,
      table: "patient",
      rowId: `${MERGE_REVIEW_PREFIX}${duplicate.id}`,
      resolvedAt: null,
    });
    expect(state.conflicts[0]?.reason?.startsWith(MERGE_REVIEW_PREFIX)).toBe(true);
    // Les deux identités sont conservées pour l'humain (payloads projetés).
    expect(state.conflicts[0]?.winning).toMatchObject({ id: canonical.id });
    expect(state.conflicts[0]?.losing).toMatchObject({ id: duplicate.id });
  });

  it("double déclencheur d'une revue → une seule entrée en attente", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state, {
      duplicate: { firstName: "Autre" },
    });
    const repo = createFakeRepo(state);
    const params = { candidateId: duplicate.id, existingId: canonical.id, now: T0 };

    const first = expectStatus(await mergeDuplicatePatients(repo, params), "review");
    const second = expectStatus(await mergeDuplicatePatients(repo, params), "review");

    expect(state.conflicts).toHaveLength(1);
    expect(second.reviewId).toBe(first.reviewId);
  });

  it("même `id` des deux côtés → `self-merge`, aucune écriture", async () => {
    const state = createState();
    const shared = makeCandidate({ id: "p-shared" });
    addPatient(state, shared);

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: shared.id,
      existingId: shared.id,
      now: T0,
    });

    expectStatus(result, "self-merge");
    expect(state.merges.size).toBe(0);
    expect(state.patients.get(shared.id)?.deletedAt).toBeNull();
  });

  it("aucun identifiant natif commun → `none` (deux dossiers distincts)", async () => {
    const state = createState();
    const left = makeCandidate({ id: "p-1", email: "a@exemple.dz" });
    const right = makeCandidate({ id: "p-2", email: "b@exemple.dz" });
    addPatient(state, left);
    addPatient(state, right);

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: left.id,
      existingId: right.id,
      now: T0,
    });

    expectStatus(result, "none");
    expect(state.conflicts).toHaveLength(0);
    expect(state.merges.size).toBe(0);
  });

  it("ligne absente → `not-found` avec l'identifiant manquant", async () => {
    const state = createState();
    const known = makeCandidate({ id: "p-known" });
    addPatient(state, known);

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: "p-fantome",
      existingId: known.id,
      now: T0,
    });

    expect(result).toEqual({ status: "not-found", missing: ["p-fantome"] });
  });

  /* Correctif 1 — garde-fou multi-cabinet au niveau transactionnel. */

  it("cabinets DIFFÉRENTS → `review` `cross-clinic`, AUCUNE écriture de fusion", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state, { duplicate: { clinicId: "clinic-2" } });
    state.children.push({ table: "appointment", id: "ap-1", patientId: duplicate.id });
    state.outbox.push({ id: "op-1", table: "patient", rowId: duplicate.id, status: "pending" });

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const review = expectStatus(result, "review");
    expect(review.reason).toBe("cross-clinic");
    // Rien n'est réorienté, tombstoné, tracé ni purgé.
    expect(state.children[0]?.patientId).toBe(duplicate.id);
    expect(state.patients.get(duplicate.id)?.deletedAt).toBeNull();
    expect(state.merges.size).toBe(0);
    expect(state.outbox[0]?.status).toBe("pending");
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({
      table: "patient",
      rowId: `${MERGE_REVIEW_PREFIX}${duplicate.id}`,
    });
  });

  /* Correctif 4 — purge de l'outbox du doublon. */

  it("outbox `pending` du doublon traitée, celle du canonique INTACTE", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    state.outbox.push(
      // Doublon : une opération à pousser → traitée (jamais réanimée).
      { id: "op-1", table: "patient", rowId: duplicate.id, status: "pending" },
      // Déjà `failed` : `pendingBatch` ne lit que `pending` → jamais rétrogradée.
      { id: "op-2", table: "patient", rowId: duplicate.id, status: "failed" },
      // Autre table du doublon : hors périmètre de `purgeOutboxFor`.
      { id: "op-3", table: "appointment", rowId: "ap-9", status: "pending" },
      // Canonique : INTACT.
      { id: "op-4", table: "patient", rowId: canonical.id, status: "pending" },
    );

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    expectStatus(result, "merged");
    expect(state.outbox.map((row) => row.status)).toEqual([
      "sent",
      "failed",
      "pending",
      "pending",
    ]);
  });

  it("params invalides (horloge caduque) → rejet Zod", async () => {
    const state = createState();
    await expect(
      mergeDuplicatePatients(createFakeRepo(state), {
        candidateId: "a",
        existingId: "b",
        now: new Date(Number.NaN),
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 2bis. Correctif 2 — chaînage de fusion borné (point fixe + cycle)           */
/* -------------------------------------------------------------------------- */

describe("mergeDuplicatePatients — chaînage borné jusqu'au point fixe", () => {
  /** Trace d'une fusion antérieure (`sync_merge`, clé = `duplicate_id`). */
  function seedMerge(state: FakeState, duplicateId: string, canonicalId: string, tag: string): void {
    state.merges.set(duplicateId, {
      id: `m-${tag}`,
      canonicalId,
      duplicateId,
      reason: "fusion antérieure",
      mergedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
  }

  it("chaîne A→B, B→C : un merge VISANT A aboutit au point fixe C", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    addPatient(state, makeCandidate({ id: "p-c" }));
    // A (le canonique pressenti) a été fusionné dans B, B dans C.
    seedMerge(state, canonical.id, "p-b", "a");
    seedMerge(state, "p-b", "p-c", "b");
    state.children.push({ table: "appointment", id: "ap-1", patientId: duplicate.id });

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const merged = expectStatus(result, "merged");
    // Point fixe atteint : JAMAIS le tombstone B, jamais A (lui-même fusionné).
    expect(merged.canonicalId).toBe("p-c");
    expect(state.merges.get(duplicate.id)).toMatchObject({
      canonicalId: "p-c",
      duplicateId: duplicate.id,
    });
    expect(state.children[0]?.patientId).toBe("p-c");
    expect(state.patients.get(duplicate.id)?.deletedAt).toEqual(T0);
  });

  it("cycle A→B, B→A → `review` (échec fermé, AUCUNE boucle infinie)", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    seedMerge(state, canonical.id, "p-b", "a");
    seedMerge(state, "p-b", canonical.id, "b");

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const review = expectStatus(result, "review");
    expect(review.reason).toContain("cycle");
    // Les traces antérieures sont intactes, le doublon ni réorienté ni
    // tombstoné : seule une revue humaine est ouverte.
    expect(state.merges.size).toBe(2);
    expect(state.patients.get(duplicate.id)?.deletedAt).toBeNull();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]?.rowId).toBe(`${MERGE_REVIEW_PREFIX}${duplicate.id}`);
  });

  it(`chaîne plus longue que la borne (${MERGE_CHAIN_MAX_HOPS}) → \`review\``, async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    // A → ch-1 → … → ch-11 : 11 redirects > borne de 10 → point fixe NON prouvé.
    let from = canonical.id;
    for (let hop = 1; hop <= MERGE_CHAIN_MAX_HOPS + 1; hop += 1) {
      const to = `ch-${hop}`;
      seedMerge(state, from, to, `${hop}`);
      from = to;
    }

    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const review = expectStatus(result, "review");
    expect(review.reason).toContain("borne");
    expect(state.merges.size).toBe(MERGE_CHAIN_MAX_HOPS + 1);
    expect(state.patients.get(duplicate.id)?.deletedAt).toBeNull();
  });

  it("aucun chaînage (le canonique pressenti est déjà le point fixe) → fusion normale", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state);
    // Aucune trace : le canonique pressenti est déjà le point fixe.
    const result = await mergeDuplicatePatients(createFakeRepo(state), {
      candidateId: duplicate.id,
      existingId: canonical.id,
      now: T0,
    });

    const merged = expectStatus(result, "merged");
    expect(merged.canonicalId).toBe(canonical.id);
    expect(state.conflicts).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2ter. Correctif 3 — clé de revue namespacée                                 */
/* -------------------------------------------------------------------------- */

describe("mergeDuplicatePatients — revue et conflits push ne se marchent pas dessus", () => {
  const PUSH_ENTRY = { table: "patient" as const, reason: "base-rev-mismatch" };

  it("un conflit push non résolu déjà présent N'ABSORBE PAS la revue de fusion", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state, { duplicate: { firstName: "Autre" } });

    // Conflit push D-4 déjà journalisé sur `patient/<doublon>` (même poste,
    // `device_id` absent) — sans namespace, la revue D-5 serait dédoublonnée
    // sur CETTE ligne et ne serait jamais écrite.
    const pushed = await recordPushConflicts(
      createFakeConflictRepo(state),
      [{ ...PUSH_ENTRY, rowId: duplicate.id }],
      T0,
    );
    expect(pushed).toBe(1);

    const review = expectStatus(
      await mergeDuplicatePatients(createFakeRepo(state), {
        candidateId: duplicate.id,
        existingId: canonical.id,
        now: T0,
      }),
      "review",
    );

    // Les deux entrées COEXISTENT.
    expect(state.conflicts).toHaveLength(2);
    expect(review.reviewId).not.toBe(state.conflicts[0]?.id);
    const reviewRow = state.conflicts.find((row) => row.id === review.reviewId);
    expect(reviewRow?.rowId).toBe(`${MERGE_REVIEW_PREFIX}${duplicate.id}`);
    expect(reviewRow?.reason?.startsWith(MERGE_REVIEW_PREFIX)).toBe(true);

    // La file de revue ne montre QUE la fusion, avec l'id du doublon brut.
    const pending = await listPendingMerges(createFakeRepo(state));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(review.reviewId);
    expect(pending[0]?.candidateId).toBe(duplicate.id);
  });

  it("la revue de fusion déjà présente N'ABSORBE PAS un conflit push ultérieur", async () => {
    const state = createState();
    const { canonical, duplicate } = seedPair(state, { duplicate: { firstName: "Autre" } });
    const repo = createFakeRepo(state);

    const review = expectStatus(
      await mergeDuplicatePatients(repo, {
        candidateId: duplicate.id,
        existingId: canonical.id,
        now: T0,
      }),
      "review",
    );
    expect(review.reviewId.length).toBeGreaterThan(0);

    // Même patient, même minute, même `device_id` (absent) : le conflit push
    // serait dédoublonné sur la revue si le `row_id` n'était pas namespacé.
    const pushed = await recordPushConflicts(
      createFakeConflictRepo(state),
      [{ ...PUSH_ENTRY, rowId: duplicate.id }],
      T0,
    );

    expect(pushed).toBe(1);
    expect(state.conflicts).toHaveLength(2);
    expect(
      state.conflicts.filter((row) => row.reason?.startsWith(MERGE_REVIEW_PREFIX)),
    ).toHaveLength(1);
    expect(state.conflicts.filter((row) => row.rowId === duplicate.id)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Revue humaine — listPendingMerges / resolveMerge                         */
/* -------------------------------------------------------------------------- */

describe("liste de revue D-5 — listPendingMerges / resolveMerge", () => {
  async function seedReview(state: FakeState): Promise<{ reviewId: string }> {
    const { canonical, duplicate } = seedPair(state, {
      duplicate: { firstName: "Autre" },
    });
    const result = expectStatus(
      await mergeDuplicatePatients(createFakeRepo(state), {
        candidateId: duplicate.id,
        existingId: canonical.id,
        now: T0,
      }),
      "review",
    );
    return { reviewId: result.reviewId };
  }

  it("liste les fusions refusées non résolues, motif sans préfixe", async () => {
    const state = createState();
    const { reviewId } = await seedReview(state);

    const pending = await listPendingMerges(createFakeRepo(state));

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(reviewId);
    expect(pending[0]?.candidateId).toBe("p-duplicate");
    expect(pending[0]?.canonicalId).toBe("p-canonical");
    expect(pending[0]?.reason).toContain("nom ou prénom");
    expect(pending[0]?.reason?.startsWith(MERGE_REVIEW_PREFIX)).toBe(false);
    expect(pending[0]?.decidedAt).toEqual(T0);
  });

  it("resolveMerge clôture l'entrée (idempotent, premier résolveur conservé)", async () => {
    const state = createState();
    const { reviewId } = await seedReview(state);
    const repo = createFakeRepo(state);

    await resolveMerge(repo, { id: reviewId, resolvedBy: "dr-dupont" });
    const afterFirst = await listPendingMerges(repo);
    expect(afterFirst).toHaveLength(0);
    expect(state.conflicts[0]).toMatchObject({ resolvedBy: "dr-dupont" });

    // Second appel : sans effet, l'entrée reste résolue par le premier.
    await resolveMerge(repo, { id: reviewId, resolvedBy: "dr-autre" });
    expect(state.conflicts[0]?.resolvedBy).toBe("dr-dupont");
    expect(await listPendingMerges(repo)).toHaveLength(0);
  });

  it("identifiant inconnu → no-op silencieux (aucune exception)", async () => {
    const state = createState();
    await expect(
      resolveMerge(createFakeRepo(state), { id: "id-inconnu", resolvedBy: "dr-dupont" }),
    ).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Inventaire des enfants                                                   */
/* -------------------------------------------------------------------------- */

describe("PATIENT_CHILD_TABLES — inventaire", () => {
  it("couvre les 14 tables portant une FK `patient_id` (noms SQL)", () => {
    const names = PATIENT_CHILD_TABLES.map((child) => child.name);
    expect(new Set(names).size).toBe(14);
    expect(names).toEqual(
      expect.arrayContaining([
        "appointment",
        "waiting_room_entry",
        "clinical_session",
        "consultation_note",
        "dental_chart",
        "medical_history_entry",
        "odontogram_state",
        "radiograph",
        "treatment_plan",
        "prescription",
        "invoice",
        "quote",
        "payment",
        "prosthesis_order",
      ]),
    );
  });
});
