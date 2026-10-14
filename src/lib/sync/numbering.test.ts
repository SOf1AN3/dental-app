import { describe, expect, it } from "vitest";
import {
  allocateLocalNumber,
  consumeBlockReservation,
  isKnownSequenceType,
  storeBlock,
  type LocalSequenceRow,
  type NumberingRepo,
} from "./numbering";

/**
 * Tests **hermétiques** (repo mémoire, aucune base, aucun réseau) de la
 * numérotation par blocs réservés — tâche 6.1 / décision D-4.
 *
 * Le repo mémoire reproduit fidèlement les contrats du repo SQL :
 *  - `advanceCursor` est un compare-and-swap (`last_number = from`) qui refuse
 *    toute écriture au-delà de `block_end` (comme le `WHERE` de production) ;
 *  - `writeBlock` / `markBlockConsumed` incrémentent `state.writes` : les tests
 *    prouvent ainsi **zéro écriture** sur un bloc épuisé.
 *
 * Le test T-5 du plan (deux postes, blocs disjoints → aucun numéro en commun)
 * est le cœur de la décision D-4.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const CLINIC = "clinic-a";
const DEVICE_1 = "device-1";
const DEVICE_2 = "device-2";

/* -------------------------------------------------------------------------- */
/* Repo mémoire                                                                */
/* -------------------------------------------------------------------------- */

function sequenceKey(clinicId: string, type: string): string {
  return `${clinicId}|${type}`;
}

interface MemoryRepo {
  repo: NumberingRepo;
  state: { rows: Map<string, LocalSequenceRow>; writes: number };
}

function seedRow(overrides: Partial<LocalSequenceRow> & Pick<LocalSequenceRow, "clinicId" | "type">): LocalSequenceRow {
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

function createMemoryRepo(initial: LocalSequenceRow[] = []): MemoryRepo {
  const rows = new Map<string, LocalSequenceRow>();
  for (const row of initial) {
    rows.set(sequenceKey(row.clinicId, row.type), { ...row });
  }
  const state = { rows, writes: 0 };

  const repo: NumberingRepo = {
    async findSequence(clinicId, type) {
      const row = rows.get(sequenceKey(clinicId, type));
      return row === undefined ? null : { ...row };
    },

    async advanceCursor(clinicId, type, from, to) {
      const row = rows.get(sequenceKey(clinicId, type));
      if (row === undefined || row.lastNumber !== from) return false;
      // Garde SQL simulée : jamais d'écriture au-delà de block_end.
      if (row.blockEnd !== null && to > row.blockEnd) return false;
      rows.set(sequenceKey(clinicId, type), { ...row, lastNumber: to });
      state.writes += 1;
      return true;
    },

    async writeBlock(params) {
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

function blockOf(mem: MemoryRepo, clinicId = CLINIC, type = "invoice"): {
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
/* 1. Allocation séquentielle dans le bloc                                     */
/* -------------------------------------------------------------------------- */

describe("allocateLocalNumber — allocation dans le bloc", () => {
  it("alloue les numéros dans l'ordre et calcule `remaining` exactement", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 3,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });

    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: true, number: 1, remaining: 2 });
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: true, number: 2, remaining: 1 });
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: true, number: 3, remaining: 0 });

    expect(blockOf(mem).cursor).toBe(3);
    expect(mem.state.writes).toBe(4); // 1 install de bloc + 3 curseurs
  });

  it("reprend au milieu du bloc si le curseur local s'y trouve déjà", async () => {
    const mem = createMemoryRepo([
      seedRow({ clinicId: CLINIC, type: "invoice", lastNumber: 7 }),
    ]);
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 51,
      blockEnd: 100,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    // Curseur 7 (hérité) < 50 → aligné sur blockStart - 1 : le 1er numéro émis
    // est EXACTEMENT blockStart, jamais un numéro déjà sorti.
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: true, number: 51, remaining: 49 });
  });

  it("ne remonte JAMAIS le curseur au-delà du bloc (jamais de numéro recréé)", async () => {
    const mem = createMemoryRepo([
      seedRow({ clinicId: CLINIC, type: "invoice", lastNumber: 300 }),
    ]);
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 51,
      blockEnd: 100,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    const writesBefore = mem.state.writes;
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "block-exhausted" });
    expect(mem.state.writes).toBe(writesBefore); // zéro écriture
    expect(blockOf(mem).cursor).toBe(300); // curseur intact
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Épuisement du bloc — refus explicite, zéro écriture                       */
/* -------------------------------------------------------------------------- */

describe("allocateLocalNumber — bloc épuisé", () => {
  it("la dernière allocation du bloc est ok, la suivante est block-exhausted sans écriture", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "quote",
      blockStart: 10,
      blockEnd: 11,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    // Première allocation : curseur aligné sur blockStart - 1 = 9.
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 10, remaining: 1 });
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "quote" }))
      .toEqual({ ok: true, number: 11, remaining: 0 });

    const writesBefore = mem.state.writes;
    const exhausted = await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "quote" });
    expect(exhausted).toEqual({ ok: false, reason: "block-exhausted" });
    expect(mem.state.writes).toBe(writesBefore); // ⚠️ zéro écriture
    expect(blockOf(mem, CLINIC, "quote").cursor).toBe(11); // jamais d'incrément au-delà de block_end
  });

  it("refuse sans bloc (aucune réservation locale)", async () => {
    const mem = createMemoryRepo([
      seedRow({ clinicId: CLINIC, type: "invoice", lastNumber: 4 }),
    ]);
    const writesBefore = mem.state.writes;
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "block-exhausted" });
    expect(mem.state.writes).toBe(writesBefore);
    expect(blockOf(mem).cursor).toBe(4);
  });

  it("refuse un bloc déjà consommé", async () => {
    const mem = createMemoryRepo([
      seedRow({
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "consumed",
        blockReservedAt: NOW,
      }),
    ]);
    const writesBefore = mem.state.writes;
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "block-exhausted" });
    expect(mem.state.writes).toBe(writesBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. storeBlock — idempotent, ne rétrécit jamais un bloc existant             */
/* -------------------------------------------------------------------------- */

describe("storeBlock", () => {
  const BLOCK = {
    clinicId: CLINIC,
    type: "invoice",
    blockStart: 1,
    blockEnd: 50,
    deviceId: DEVICE_1,
    reservedAt: NOW,
  } as const;

  it("installe le bloc et aligne le curseur sur blockStart - 1", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, BLOCK);
    expect(blockOf(mem)).toEqual({
      start: 1,
      end: 50,
      status: "reserved",
      cursor: 0,
    });
    expect(mem.state.writes).toBe(1);
  });

  it("est idempotent : rejouer le même bloc ne réécrit rien", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, BLOCK);
    await storeBlock(mem.repo, BLOCK);
    await storeBlock(mem.repo, { ...BLOCK, deviceId: DEVICE_2 });
    expect(mem.state.writes).toBe(1);
    expect(blockOf(mem)).toEqual({ start: 1, end: 50, status: "reserved", cursor: 0 });
  });

  it("ne rétrécit ni n'écrase JAMAIS un bloc non épuisé (même avec un bloc plus petit)", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, BLOCK);
    await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }); // 1 émis

    await storeBlock(mem.repo, { ...BLOCK, blockStart: 1, blockEnd: 10 });
    await storeBlock(mem.repo, { ...BLOCK, blockStart: 51, blockEnd: 100 });

    expect(blockOf(mem)).toEqual({ start: 1, end: 50, status: "reserved", cursor: 1 });
    expect(mem.state.writes).toBe(2); // 1 install + 1 curseur (les 2 storeBlock suivants : 0)
  });

  it("remplace un bloc consommé par un bloc strictement supérieur, curseur aligné", async () => {
    const mem = createMemoryRepo([
      seedRow({
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "consumed",
        blockReservedAt: NOW,
      }),
    ]);
    await storeBlock(mem.repo, { ...BLOCK, blockStart: 51, blockEnd: 100 });
    expect(blockOf(mem)).toEqual({
      start: 51,
      end: 100,
      status: "reserved",
      cursor: 50,
    });
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: true, number: 51, remaining: 49 });
  });

  it("ne réinstalle jamais un bloc consommé plus grand que le nouveau", async () => {
    const mem = createMemoryRepo([
      seedRow({
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 100,
        blockStart: 1,
        blockEnd: 100,
        blockDeviceId: DEVICE_1,
        blockStatus: "consumed",
        blockReservedAt: NOW,
      }),
    ]);
    const writesBefore = mem.state.writes;
    await storeBlock(mem.repo, { ...BLOCK, blockStart: 51, blockEnd: 100 });
    expect(mem.state.writes).toBe(writesBefore);
    expect(blockOf(mem)).toEqual({
      start: 1,
      end: 100,
      status: "consumed",
      cursor: 100,
    });
  });

  it("refuse des bornes incohérentes et un type inconnu", async () => {
    const mem = createMemoryRepo();
    await expect(
      storeBlock(mem.repo, { ...BLOCK, blockStart: 10, blockEnd: 9 }),
    ).rejects.toThrow();
    await expect(
      storeBlock(mem.repo, { ...BLOCK, blockStart: 0, blockEnd: 50 }),
    ).rejects.toThrow();
    await expect(
      storeBlock(mem.repo, { ...BLOCK, type: "ordonnance" }),
    ).rejects.toThrow();
    expect(mem.state.writes).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Portée : no-clinic, unknown-type                                         */
/* -------------------------------------------------------------------------- */

describe("allocateLocalNumber — portée", () => {
  it("renvoie no-clinic quand aucune séquence locale n'existe pour le cabinet", async () => {
    const mem = createMemoryRepo([
      seedRow({ clinicId: "autre-cabinet", type: "invoice", lastNumber: 3 }),
    ]);
    const writesBefore = mem.state.writes;
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "no-clinic" });
    expect(mem.state.writes).toBe(writesBefore);
  });

  it("renvoie unknown-type pour un type non numérotable", async () => {
    const mem = createMemoryRepo([
      seedRow({ clinicId: CLINIC, type: "invoice", lastNumber: 3 }),
    ]);
    const writesBefore = mem.state.writes;
    expect(await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "facture" }))
      .toEqual({ ok: false, reason: "unknown-type" });
    expect(mem.state.writes).toBe(writesBefore);
  });

  it("reconnait les types réellement numérotés du dépôt", () => {
    expect(isKnownSequenceType("invoice")).toBe(true);
    expect(isKnownSequenceType("quote")).toBe(true);
    expect(isKnownSequenceType("prosthesis:2026")).toBe(true);
    expect(isKnownSequenceType("prosthesis:26")).toBe(false);
    expect(isKnownSequenceType("prescription")).toBe(false);
    expect(isKnownSequenceType("")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. consumeBlockReservation — traçabilité                                    */
/* -------------------------------------------------------------------------- */

describe("consumeBlockReservation", () => {
  it("marque consumed uniquement quand le bloc est vide", async () => {
    const mem = createMemoryRepo();
    await storeBlock(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 2,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });

    // Bloc encore plein → aucune écriture.
    await consumeBlockReservation(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 2,
    });
    expect(blockOf(mem).status).toBe("reserved");
    expect(mem.state.writes).toBe(1);

    // Dernier numéro émis → le bloc est vide → tracé `consumed`.
    await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" });
    await allocateLocalNumber(mem.repo, { clinicId: CLINIC, type: "invoice" });
    await consumeBlockReservation(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 2,
    });
    expect(blockOf(mem).status).toBe("consumed");

    // Idempotent (déjà consommé → plus rien) et bornes différentes ignorées.
    const writesAfter = mem.state.writes;
    await consumeBlockReservation(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 2,
    });
    await consumeBlockReservation(mem.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 99,
      blockEnd: 198,
    });
    expect(mem.state.writes).toBe(writesAfter);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. T-5 — deux postes, blocs distincts, aucun numéro en commun                */
/* -------------------------------------------------------------------------- */

describe("T-5 — deux postes ne peuvent jamais produire le même numéro", () => {
  it("les blocs [1..50] (poste A) et [51..100] (poste B) sont disjoints", async () => {
    // Deux repos indépendants = deux postes physiques distincts.
    const posteA = createMemoryRepo();
    const posteB = createMemoryRepo();

    await storeBlock(posteA.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 1,
      blockEnd: 50,
      deviceId: DEVICE_1,
      reservedAt: NOW,
    });
    await storeBlock(posteB.repo, {
      clinicId: CLINIC,
      type: "invoice",
      blockStart: 51,
      blockEnd: 100,
      deviceId: DEVICE_2,
      reservedAt: NOW,
    });

    const numbersA: number[] = [];
    const numbersB: number[] = [];

    for (let i = 0; i < 50; i += 1) {
      const a = await allocateLocalNumber(posteA.repo, { clinicId: CLINIC, type: "invoice" });
      expect(a.ok).toBe(true);
      if (a.ok) numbersA.push(a.number);
      const b = await allocateLocalNumber(posteB.repo, { clinicId: CLINIC, type: "invoice" });
      expect(b.ok).toBe(true);
      if (b.ok) numbersB.push(b.number);
    }

    // Les deux postes ont intégralement consommé leur bloc…
    expect(numbersA).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(numbersB).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 51),
    );
    expect(numbersA).toHaveLength(50);
    expect(numbersB).toHaveLength(50);

    // …sans AUCUN doublon entre eux (l'union compte 100 numéros uniques).
    const union = new Set([...numbersA, ...numbersB]);
    expect(union.size).toBe(100);
    for (const number of numbersA) {
      expect(numbersB).not.toContain(number);
    }

    // Blocs épuisés des deux côtés → refus explicite, zéro écriture de trop.
    const writesA = posteA.state.writes;
    const writesB = posteB.state.writes;
    expect(await allocateLocalNumber(posteA.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "block-exhausted" });
    expect(await allocateLocalNumber(posteB.repo, { clinicId: CLINIC, type: "invoice" }))
      .toEqual({ ok: false, reason: "block-exhausted" });
    expect(posteA.state.writes).toBe(writesA);
    expect(posteB.state.writes).toBe(writesB);
  });
});
