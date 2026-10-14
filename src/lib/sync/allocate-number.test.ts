import { describe, expect, it, vi } from "vitest";
import {
  allocateDocumentNumber,
  allocateNumberErrorMessage,
  createDeviceAllocateDeps,
  type AllocateDeps,
} from "./allocate-number";
import {
  storeBlock,
  type LocalSequenceRow,
  type NumberingRepo,
} from "./numbering";

/**
 * Tests **hermétiques** de l'allocateur de numéros mode blocs (tâche 6.1c) :
 * repo mémoire (aucune base) + `fetchImpl` stubbé (aucun réseau).
 *
 * Couverture exigée :
 *  - bloc disponible → 1 lecture, **zéro** appel réseau ;
 *  - bloc épuisé + env complète → réservation, `consume` **avant** `store`,
 *    allocation réussie (contrat de la requête `POST /api/sync/blocks`) ;
 *  - env incomplète → `no-block-available`, **zéro écriture**, **zéro appel
 *    réseau** (jamais d'incrément improvisé) ;
 *  - 401 / réseau / réponse non conforme → `reservation-failed` ;
 *  - renouvellement resté sans effet → `no-block-available` après **une seule**
 *    requête (boucle bornée à 1) ;
 *  - CAS contesté → `no-block-available` (jamais une erreur 500 muette).
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const CLINIC = "clinic-a";
const DEVICE_1 = "device-1";
const BASE_URL = "https://central.test";
const SECRET_TOKEN = "tok_very_secret_value_xyz";

/* -------------------------------------------------------------------------- */
/* Repo mémoire (contrats identiques au repo SQL)                              */
/* -------------------------------------------------------------------------- */

function sequenceKey(clinicId: string, type: string): string {
  return `${clinicId}|${type}`;
}

interface MemoryRepoState {
  rows: Map<string, LocalSequenceRow>;
  /** Nombre d'appels `findSequence` (preuve de « 1 lecture »). */
  reads: number;
  /** Nombre d'écritures effectives (preuve de « zéro écriture »). */
  writes: number;
  /** Journal des opérations d'écriture (`consume` / `store` / `advance`). */
  ops: string[];
}

function seedRow(
  overrides: Partial<LocalSequenceRow> & Pick<LocalSequenceRow, "clinicId" | "type">,
): LocalSequenceRow {
  return {
    lastNumber: 0,
    blockStart: null,
    blockEnd: null,
    blockDeviceId: null,
    blockStatus: null,
    blockReservedAt: null,
    ...overrides,
  };
}

/** Bloc `reserved` entièrement consommé (`lastNumber = blockEnd`). */
function exhaustedRow(type = "invoice"): LocalSequenceRow {
  return seedRow({
    clinicId: CLINIC,
    type,
    lastNumber: 2,
    blockStart: 1,
    blockEnd: 2,
    blockDeviceId: DEVICE_1,
    blockStatus: "reserved",
    blockReservedAt: NOW,
  });
}

function createMemoryRepo(
  initial: LocalSequenceRow[] = [],
  options: { failCas?: boolean } = {},
): { repo: NumberingRepo; state: MemoryRepoState } {
  const rows = new Map<string, LocalSequenceRow>();
  for (const row of initial) {
    rows.set(sequenceKey(row.clinicId, row.type), { ...row });
  }
  const state: MemoryRepoState = { rows, reads: 0, writes: 0, ops: [] };

  const repo: NumberingRepo = {
    async findSequence(clinicId, type) {
      state.reads += 1;
      const row = rows.get(sequenceKey(clinicId, type));
      return row === undefined ? null : { ...row };
    },

    async advanceCursor(clinicId, type, from, to) {
      state.ops.push("advance");
      if (options.failCas === true) return false;
      const row = rows.get(sequenceKey(clinicId, type));
      if (row === undefined || row.lastNumber !== from) return false;
      // Garde SQL simulée : jamais d'écriture au-delà de block_end.
      if (row.blockEnd !== null && to > row.blockEnd) return false;
      rows.set(sequenceKey(clinicId, type), { ...row, lastNumber: to });
      state.writes += 1;
      return true;
    },

    async writeBlock(params) {
      state.ops.push("store");
      rows.set(sequenceKey(params.clinicId, params.type), {
        clinicId: params.clinicId,
        type: params.type,
        lastNumber: params.cursor,
        blockStart: params.blockStart,
        blockEnd: params.blockEnd,
        blockDeviceId: params.deviceId,
        blockStatus: "reserved",
        blockReservedAt: params.reservedAt,
      });
      state.writes += 1;
    },

    async markBlockConsumed(clinicId, type, blockStart, blockEnd) {
      state.ops.push("consume");
      const row = rows.get(sequenceKey(clinicId, type));
      if (
        row === undefined ||
        row.blockStatus !== "reserved" ||
        row.blockStart !== blockStart ||
        row.blockEnd !== blockEnd
      ) {
        return false;
      }
      rows.set(sequenceKey(clinicId, type), { ...row, blockStatus: "consumed" });
      state.writes += 1;
      return true;
    },
  };

  return { repo, state };
}

function blockOf(
  mem: { state: MemoryRepoState },
  clinicId = CLINIC,
  type = "invoice",
): {
  start: number | null;
  end: number | null;
  status: LocalSequenceRow["blockStatus"];
  cursor: number;
} {
  const row = mem.state.rows.get(sequenceKey(clinicId, type));
  expect(row, "ligne de séquence attendue").toBeDefined();
  return {
    start: row?.blockStart ?? null,
    end: row?.blockEnd ?? null,
    status: row?.blockStatus ?? null,
    cursor: row?.lastNumber ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Stubs fetch / deps                                                          */
/* -------------------------------------------------------------------------- */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonReservation(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createFetchStub(
  handler?: (url: string, init?: RequestInit) => Response,
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (handler === undefined) {
      throw new Error(`appel réseau inattendu : ${url}`);
    }
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function createDeps(overrides: Partial<AllocateDeps> = {}): AllocateDeps {
  return {
    numbering: createMemoryRepo().repo,
    fetchImpl: async () => {
      throw new Error("aucun appel réseau attendu dans ce test");
    },
    baseUrl: BASE_URL,
    deviceId: DEVICE_1,
    syncToken: SECRET_TOKEN,
    now: () => NOW,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Chemin chaud — bloc disponible                                           */
/* -------------------------------------------------------------------------- */

describe("allocateDocumentNumber — chemin chaud (bloc disponible)", () => {
  it("alloue localement : 1 lecture, zéro écriture de bloc, zéro appel réseau", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 50,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    const { calls, fetchImpl } = createFetchStub();
    const deps = createDeps({ numbering: mem.repo, fetchImpl });
    // `storeBlock` (setup) a déjà lu la ligne une fois : on mesure l'écart.
    const readsBefore = mem.state.reads;
    mem.state.ops.length = 0; // le journal ne reflète que l'allocation testée

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: true, number: 1 });
    expect(calls).toHaveLength(0); // zéro appel réseau
    expect(mem.state.reads - readsBefore).toBe(1); // 1 seule lecture (`findSequence`)
    expect(mem.state.writes).toBe(2); // 1 install (setup) + 1 avance de curseur
    // Seule opération hors setup : l'avance de curseur (aucun `consume`/`store`).
    expect(mem.state.ops).toEqual(["advance"]);
  });

  it("continue d'allouer dans le même bloc, puis réserve dès le 1er numéro au-delà de blockEnd", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "quote",
      blockStart: 10,
      blockEnd: 12,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    const { calls, fetchImpl } = createFetchStub(() =>
      jsonReservation({
        blockStart: 13,
        blockEnd: 62,
        clinicId: CLINIC,
        type: "quote",
      }),
    );
    const deps = createDeps({ numbering: mem.repo, fetchImpl });

    expect(await allocateDocumentNumber(deps, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 10 });
    expect(await allocateDocumentNumber(deps, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 11 });
    expect(await allocateDocumentNumber(deps, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 12 });
    expect(calls).toHaveLength(0); // tout le bloc tient dans le local

    // 13 > blockEnd (12) → un seul renouvellement, puis allocation continue.
    expect(await allocateDocumentNumber(deps, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 13 });
    expect(calls).toHaveLength(1);
    expect(blockOf(mem, CLINIC, "quote")).toEqual({
      start: 13,
      end: 62,
      status: "reserved",
      cursor: 13,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Bloc épuisé — réservation, consume PUIS store                            */
/* -------------------------------------------------------------------------- */

describe("allocateDocumentNumber — renouvellement d'un bloc épuisé", () => {
  it("réserve, consomme AVANT de stocker, puis alloue le 1er numéro du nouveau bloc", async () => {
    const mem = createMemoryRepo([exhaustedRow()]);
    const { calls, fetchImpl } = createFetchStub(() =>
      jsonReservation({
        blockStart: 3,
        blockEnd: 52,
        clinicId: CLINIC,
        type: "invoice",
      }),
    );
    const deps = createDeps({ numbering: mem.repo, fetchImpl });

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: true, number: 3 });

    // Contrat de la requête : URL, jeton, corps `{clinicId,type,size,cursor}`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/sync/blocks`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET_TOKEN}`);
    const body = JSON.parse(String(calls[0]?.init?.body)) as unknown;
    expect(body).toEqual({
      clinicId: CLINIC,
      type: "invoice",
      size: 50,
      cursor: 2, // `last_number` local = preuve d'épuisement
    });

    // ⚠️ Ordre OBLIGATOIRE (revue 6.1b, mineur 1) : consume avant store.
    const consumeIndex = mem.state.ops.indexOf("consume");
    const storeIndex = mem.state.ops.indexOf("store");
    expect(consumeIndex).toBeGreaterThanOrEqual(0);
    expect(storeIndex).toBeGreaterThan(consumeIndex);

    // Nouveau bloc installé, curseur aligné sur le 1er numéro émis, horloge injectée.
    expect(blockOf(mem)).toEqual({ start: 3, end: 52, status: "reserved", cursor: 3 });
    const row = mem.state.rows.get(sequenceKey(CLINIC, "invoice"));
    expect(row?.blockReservedAt).toEqual(NOW);
  });

  it("crée la ligne de séquence quand aucun bloc local n'existait (no-clinic)", async () => {
    const mem = createMemoryRepo();
    const { fetchImpl } = createFetchStub(() =>
      jsonReservation({
        blockStart: 1,
        blockEnd: 50,
        clinicId: CLINIC,
        type: "invoice",
      }),
    );
    const deps = createDeps({ numbering: mem.repo, fetchImpl });

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: true, number: 1 });
    expect(blockOf(mem)).toEqual({ start: 1, end: 50, status: "reserved", cursor: 1 });
  });

  it("renouvellement resté sans effet : no-block-available après UNE SEULE requête (boucle bornée)", async () => {
    // Le central renvoie idempotement le bloc déjà épuisé [1..2] : `storeBlock`
    // ne remplace pas un bloc consommé de même hauteur → 2e échec local.
    const mem = createMemoryRepo([exhaustedRow()]);
    const { calls, fetchImpl } = createFetchStub(() =>
      jsonReservation({
        blockStart: 1,
        blockEnd: 2,
        clinicId: CLINIC,
        type: "invoice",
      }),
    );
    const deps = createDeps({ numbering: mem.repo, fetchImpl });

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: false, reason: "no-block-available" });
    expect(calls).toHaveLength(1); // une seule réservation : pas de boucle infinie
    expect(blockOf(mem).status).toBe("consumed"); // l'ancien bloc est tracé
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Configuration incomplète — refus sans écriture ni réseau                 */
/* -------------------------------------------------------------------------- */

describe("allocateDocumentNumber — configuration de réservation incomplète", () => {
  it("no-block-available, zéro écriture et zéro appel réseau pour chaque pièce manquante", async () => {
    const cases: Array<{ label: string; override: Partial<AllocateDeps> }> = [
      { label: "sans SYNC_BASE_URL", override: { baseUrl: undefined } },
      { label: "sans DEVICE_ID", override: { deviceId: undefined } },
      { label: "sans SYNC_TOKEN", override: { syncToken: undefined } },
      { label: "avec des chaînes vides", override: { baseUrl: "", syncToken: "" } },
    ];

    for (const { label, override } of cases) {
      const mem = createMemoryRepo([exhaustedRow()]);
      const { calls, fetchImpl } = createFetchStub();
      const deps = createDeps({ numbering: mem.repo, fetchImpl, ...override });
      const writesBefore = mem.state.writes;

      const result = await allocateDocumentNumber(deps, {
        clinicId: CLINIC,
        type: "invoice",
      });

      expect(result, label).toEqual({ ok: false, reason: "no-block-available" });
      expect(calls, label).toHaveLength(0); // zéro appel réseau
      expect(mem.state.writes, label).toBe(writesBefore); // zéro écriture
      expect(blockOf(mem).status, label).toBe("reserved"); // bloc intact
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Échecs de réservation — reservation-failed, zéro écriture, zéro secret   */
/* -------------------------------------------------------------------------- */

describe("allocateDocumentNumber — échecs de réservation", () => {
  it("HTTP 401 → reservation-failed, zéro écriture, aucun secret journalisé", async () => {
    const warnings: string[] = [];
    const mem = createMemoryRepo([exhaustedRow()]);
    const { fetchImpl } = createFetchStub(() => new Response(null, { status: 401 }));
    const deps = createDeps({
      numbering: mem.repo,
      fetchImpl,
      logger: { warn: (message) => warnings.push(message) },
    });
    const writesBefore = mem.state.writes;

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: false, reason: "reservation-failed" });
    expect(mem.state.writes).toBe(writesBefore); // zéro écriture : consume/store non atteints
    expect(warnings.join("\n")).toContain("HTTP 401");
    expect(warnings.join("\n")).not.toContain(SECRET_TOKEN); // jamais de jeton
  });

  it.each([500, 403])("HTTP %s → reservation-failed, zéro écriture", async (status) => {
    const mem = createMemoryRepo([exhaustedRow()]);
    const { fetchImpl } = createFetchStub(() => new Response(null, { status }));
    const deps = createDeps({ numbering: mem.repo, fetchImpl });
    const writesBefore = mem.state.writes;

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: false, reason: "reservation-failed" });
    expect(mem.state.writes).toBe(writesBefore);
  });

  it("réseau absent (fetch rejette) → reservation-failed, zéro écriture", async () => {
    const warnings: string[] = [];
    const mem = createMemoryRepo([exhaustedRow()]);
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:443");
    };
    const deps = createDeps({
      numbering: mem.repo,
      fetchImpl,
      logger: { warn: (message) => warnings.push(message) },
    });
    const writesBefore = mem.state.writes;

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    expect(result).toEqual({ ok: false, reason: "reservation-failed" });
    expect(mem.state.writes).toBe(writesBefore);
    expect(warnings.join("\n")).toContain("ECONNREFUSED"); // motif tracé, sans secret
    expect(warnings.join("\n")).not.toContain(SECRET_TOKEN);
  });

  it("réponse 200 non conforme → reservation-failed (bornes incohérentes, puis portée inattendue)", async () => {
    for (const payload of [
      { blockStart: 10, blockEnd: 5, clinicId: CLINIC, type: "invoice" }, // bornes inversées
      { blockStart: 0, blockEnd: 5, clinicId: CLINIC, type: "invoice" }, // start < 1
      { blockStart: 3, blockEnd: 52, clinicId: "autre-cabinet", type: "invoice" }, // cabinet inattendu
      { blockStart: 3, blockEnd: 52, clinicId: CLINIC, type: "quote" }, // type inattendu
      { unexpected: true },
    ]) {
      const warnings: string[] = [];
      const mem = createMemoryRepo([exhaustedRow()]);
      const { fetchImpl } = createFetchStub(() => jsonReservation(payload));
      const deps = createDeps({
        numbering: mem.repo,
        fetchImpl,
        logger: { warn: (message) => warnings.push(message) },
      });
      const writesBefore = mem.state.writes;

      const result = await allocateDocumentNumber(deps, {
        clinicId: CLINIC,
        type: "invoice",
      });

      expect(result).toEqual({ ok: false, reason: "reservation-failed" });
      expect(mem.state.writes).toBe(writesBefore); // aucune écriture sur refus
      expect(warnings.join("\n")).not.toContain(SECRET_TOKEN);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Refus purs — CAS, type inconnu                                          */
/* -------------------------------------------------------------------------- */

describe("allocateDocumentNumber — refus sans réseau", () => {
  it("curseur contesté (CAS persistant) → no-block-available, zéro appel réseau, zéro écriture", async () => {
    const mem = createMemoryRepo(
      [seedRow({ clinicId: CLINIC, type: "invoice", blockStart: 1, blockEnd: 50 })],
      { failCas: true },
    );
    const { calls, fetchImpl } = createFetchStub();
    const deps = createDeps({ numbering: mem.repo, fetchImpl });
    const writesBefore = mem.state.writes;

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "invoice",
    });

    // L'exception CAS d'`allocateLocalNumber` est convertie en refus lisible.
    expect(result).toEqual({ ok: false, reason: "no-block-available" });
    expect(calls).toHaveLength(0); // aucune réservation tentée
    expect(mem.state.writes).toBe(writesBefore);
  });

  it("type non numérotable → unknown-type, zéro appel réseau, zéro écriture", async () => {
    const mem = createMemoryRepo([seedRow({ clinicId: CLINIC, type: "facture" })]);
    const { calls, fetchImpl } = createFetchStub();
    const deps = createDeps({ numbering: mem.repo, fetchImpl });
    const writesBefore = mem.state.writes;

    const result = await allocateDocumentNumber(deps, {
      clinicId: CLINIC,
      type: "facture",
    });

    expect(result).toEqual({ ok: false, reason: "unknown-type" });
    expect(calls).toHaveLength(0);
    expect(mem.state.writes).toBe(writesBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Messages actionnable + pont env → deps                                   */
/* -------------------------------------------------------------------------- */

describe("allocateNumberErrorMessage / createDeviceAllocateDeps", () => {
  it("chaque raison de refus expose un message actionnable en français", () => {
    const reasons = [
      "not-a-device",
      "no-block-available",
      "reservation-failed",
      "no-clinic",
      "unknown-type",
    ] as const;
    for (const reason of reasons) {
      const message = allocateNumberErrorMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message).toMatch(/[A-Za-zÀ-ÿ]/);
    }
    // Le message d'exemple imposé par le cahier des charges.
    expect(allocateNumberErrorMessage("no-block-available")).toContain(
      "connectez-vous",
    );
  });

  it("createDeviceAllocateDeps reflète l'environnement courant (jamais journalisé)", () => {
    vi.stubEnv("SYNC_BASE_URL", BASE_URL);
    vi.stubEnv("DEVICE_ID", DEVICE_1);
    vi.stubEnv("SYNC_TOKEN", SECRET_TOKEN);
    try {
      const deps = createDeviceAllocateDeps(createMemoryRepo().repo);
      expect(deps.baseUrl).toBe(BASE_URL);
      expect(deps.deviceId).toBe(DEVICE_1);
      expect(deps.syncToken).toBe(SECRET_TOKEN);
      expect(deps.now()).toBeInstanceOf(Date);
      // Le repo injecté est celui fourni (aucune base cachée).
      expect(deps.numbering).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
