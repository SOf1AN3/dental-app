import { describe, expect, it } from "vitest";
import {
  createSyncBlocksHandler,
  reserveBlockCore,
  type LockedSequenceRow,
  type SequenceStore,
} from "@/app/api/sync/blocks/route";
import { computeBlockStart, maxNumericSuffix } from "@/lib/sync/block-floor";
import type { DeviceTokenContext } from "@/lib/sync/central-auth";

/**
 * Tests **hermétiques** (magasin mémoire + plancher injectés, aucune base) du
 * renouvellement de blocs et du plancher anti-doublon — tâche 6.1b.
 *
 * `reserveBlockCore` est le cœur testable de `POST /api/sync/blocks` : il prend
 * une {@link SequenceStore} et un plancher `highestIssued` injectés. Les tests
 * prouvent ici, sans base :
 *  - **renouvellement** : bloc épuisé (`cursor = block_end`) → nouveau bloc
 *    disjoint, ancien bloc `consumed` ;
 *  - **idempotence** : bloc non épuisé → renvoyé tel quel, **zéro écriture** ;
 *  - **jamais de vol** : bloc d'un autre device → nouveau bloc, non réattribué ;
 *  - **client menteur** : `cursor` exagéré → nouveau bloc **au-dessus des
 *    numéros émis**, aucun doublon possible (seulement des trous) ;
 *  - **plancher** : compteur rétrogradé → `blockStart` plané sur
 *    `highestIssued + 1`, `last_number` aligné.
 *
 * Les tests de **route** (400 / 401 / 403) passent par la fabrique injectable
 * `createSyncBlocksHandler` (deps mémoire, aucun réseau).
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const CLINIC = "clinic-a";
const DEVICE_1 = "device-1";
const DEVICE_2 = "device-2";

function ctxFor(deviceId: string, clinicIds: string[] = [CLINIC]): DeviceTokenContext {
  return {
    deviceId,
    userId: "user-1",
    clinicIds,
    trustExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

/* -------------------------------------------------------------------------- */
/* Magasin mémoire                                                             */
/* -------------------------------------------------------------------------- */

interface SeedRow extends LockedSequenceRow {
  clinicId: string;
  type: string;
}

interface MemoryStoreHarness {
  store: SequenceStore;
  /** Compteurs d'écritures observés. */
  metrics: { writes: number; consumed: number };
  row(clinicId: string, type: string): LockedSequenceRow | undefined;
}

function createMemoryStore(initial: SeedRow[] = []): MemoryStoreHarness {
  const rows = new Map<string, SeedRow>();
  for (const r of initial) rows.set(`${r.clinicId}|${r.type}`, { ...r });
  const metrics = { writes: 0, consumed: 0 };

  const row = (clinicId: string, type: string): LockedSequenceRow | undefined => {
    const found = rows.get(`${clinicId}|${type}`);
    return found === undefined
      ? undefined
      : {
          lastNumber: found.lastNumber,
          blockStart: found.blockStart,
          blockEnd: found.blockEnd,
          blockDeviceId: found.blockDeviceId,
          blockStatus: found.blockStatus,
        };
  };

  const store: SequenceStore = {
    async insertIfAbsent(clinicId, type) {
      if (!rows.has(`${clinicId}|${type}`)) {
        rows.set(`${clinicId}|${type}`, {
          clinicId,
          type,
          lastNumber: 0,
          blockStart: null,
          blockEnd: null,
          blockDeviceId: null,
          blockStatus: null,
        });
      }
    },
    async lockRow(clinicId, type) {
      return row(clinicId, type) ?? null;
    },
    async writeBlock(clinicId, type, patch) {
      rows.set(`${clinicId}|${type}`, {
        clinicId,
        type,
        lastNumber: patch.blockEnd,
        blockStart: patch.blockStart,
        blockEnd: patch.blockEnd,
        blockDeviceId: patch.deviceId,
        blockStatus: "reserved",
      });
      metrics.writes += 1;
    },
    async markConsumed(clinicId, type) {
      const found = rows.get(`${clinicId}|${type}`);
      if (found !== undefined && found.blockStatus === "reserved") {
        found.blockStatus = "consumed";
      }
      metrics.consumed += 1;
    },
  };

  return { store, metrics, row };
}

/* -------------------------------------------------------------------------- */
/* Plancher — logique pure                                                     */
/* -------------------------------------------------------------------------- */

describe("block-floor (logique pure)", () => {
  it("extrait le compteur final malgré préfixe, année et zéros", () => {
    expect(maxNumericSuffix(["FAC-2026-00042"])).toBe(42);
    expect(maxNumericSuffix(["DEV-2025-0007"])).toBe(7);
    expect(maxNumericSuffix(["PRO-2026-00001"])).toBe(1);
  });

  it("renvoie le plus élevé parmi plusieurs, 0 si vide/non numeric", () => {
    expect(maxNumericSuffix([])).toBe(0);
    expect(maxNumericSuffix(["abc", "—"])).toBe(0);
    expect(maxNumericSuffix(["FAC-2026-00003", "FAC-2025-00042", "FAC-2026-00010"])).toBe(42);
  });

  it("computeBlockStart = max(lastNumber, highestIssued) + 1", () => {
    // Plancher inactif : last_number domine.
    expect(computeBlockStart(50, 10)).toBe(51);
    // Plancher actif : compteur rétrogradé sous un numéro déjà émis.
    expect(computeBlockStart(3, 42)).toBe(43);
  });
});

/* -------------------------------------------------------------------------- */
/* Renouvellement / idempotence / vol / menteur / plancher                     */
/* -------------------------------------------------------------------------- */

describe("reserveBlockCore — renouvellement d'un bloc épuisé", () => {
  it("cursor = block_end → ancien bloc consumed + nouveau bloc disjoint", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "reserved",
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 50, // tous les numéros du bloc émis
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50, cursor: 50 },
      NOW,
    );

    expect(res).toEqual({ blockStart: 51, blockEnd: 100, type: "invoice", clinicId: CLINIC });
    // Disjoint de [1..50] : aucun recouvrement.
    expect(res.blockStart).toBeGreaterThan(50);
    expect(h.metrics.consumed).toBe(1); // l'ancien bloc [1..50] est passé consumed
    expect(h.metrics.writes).toBe(1); // une seule découpe
    expect(h.row(CLINIC, "invoice")?.blockStatus).toBe("reserved");
    expect(h.row(CLINIC, "invoice")?.blockStart).toBe(51);
  });
});

describe("reserveBlockCore — idempotence", () => {
  it("cursor < block_end → même bloc renvoyé, zéro écriture", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 30,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "reserved",
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 50,
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50, cursor: 30 },
      NOW,
    );

    expect(res).toEqual({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC });
    expect(h.metrics.writes).toBe(0);
    expect(h.metrics.consumed).toBe(0);
  });

  it("sans cursor → jamais considéré épuisé, même bloc, zéro écriture", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "reserved",
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 50,
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50 },
      NOW,
    );

    expect(res).toEqual({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC });
    expect(h.metrics.writes).toBe(0);
    expect(h.metrics.consumed).toBe(0);
  });
});

describe("reserveBlockCore — jamais de vol d'un bloc d'un autre device", () => {
  it("bloc reserved d'un autre device → nouveau bloc alloué, jamais consumé", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_2, // détenu par un AUTRE poste
        blockStatus: "reserved",
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 50,
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50 },
      NOW,
    );

    // DEVICE_1 n'obtient PAS [1..50] : un nouveau bloc disjoint au-delà.
    expect(res).toEqual({ blockStart: 51, blockEnd: 100, type: "invoice", clinicId: CLINIC });
    expect(res.blockStart).toBeGreaterThan(50);
    // Le bloc de DEVICE_2 n'est pas marqué consumed (on ne touche pas à l'autre).
    expect(h.metrics.consumed).toBe(0);
    expect(h.metrics.writes).toBe(1);
  });
});

describe("reserveBlockCore — client menteur (cursor exagéré)", () => {
  it("cursor = 999 sur [1..50] → nouveau bloc, aucun numéro déjà émis recréé", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 50,
        blockStart: 1,
        blockEnd: 50,
        blockDeviceId: DEVICE_1,
        blockStatus: "reserved",
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 50, // plancher = numéros RÉELLEMENT émis (50), pas le curseur menti (999)
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50, cursor: 999 },
      NOW,
    );

    // Le plancher ne dépend QUE des numéros émis : blockStart = 51 (pas 1000).
    expect(res.blockStart).toBe(51);
    // Aucun numéro déjà émis (≤ 50) dans le nouveau bloc → jamais de doublon.
    expect(res.blockStart).toBeGreaterThan(50);
    expect(h.metrics.consumed).toBe(1); // le bloc épuisé est consommé
    expect(h.metrics.writes).toBe(1);
  });
});

describe("reserveBlockCore — plancher des numéros déjà émis", () => {
  it("last_number = 3 mais facture …-042 émise → bloc à partir de 43, last_number aligné", async () => {
    const h = createMemoryStore([
      {
        clinicId: CLINIC,
        type: "invoice",
        lastNumber: 3, // compteur rétrogradé
        blockStart: null,
        blockEnd: null,
        blockDeviceId: null,
        blockStatus: null,
      },
    ]);

    const res = await reserveBlockCore(
      h.store,
      async () => 42, // une facture FAC-…-00042 existe réellement
      ctxFor(DEVICE_1),
      { clinicId: CLINIC, type: "invoice", size: 50 },
      NOW,
    );

    // Plancher : blockStart = max(3, 42) + 1 = 43 — ne repasse jamais sous 42.
    expect(res.blockStart).toBe(43);
    expect(res.blockEnd).toBe(92);
    // last_number aligné sur blockEnd (≥ 42) dans la même écriture.
    expect(h.row(CLINIC, "invoice")?.lastNumber).toBe(92);
    expect(h.metrics.writes).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Route HTTP — 400 / 401 / 403 (fabrique injectable)                         */
/* -------------------------------------------------------------------------- */

function postRequest(headers: Record<string, string>, body: unknown): Request {
  return new Request("http://localhost/api/sync/blocks", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/sync/blocks — contrôles d'entrée", () => {
  const okCtx = ctxFor(DEVICE_1);

  it("401 sans jeton", async () => {
    const handler = createSyncBlocksHandler({
      verifyToken: async () => okCtx,
      reserve: async () => ({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC }),
    });
    const res = await handler(postRequest({}, { clinicId: CLINIC, type: "invoice" }));
    expect(res.status).toBe(401);
  });

  it("400 sur cursor invalide (négatif)", async () => {
    const handler = createSyncBlocksHandler({
      verifyToken: async () => okCtx,
      reserve: async () => ({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC }),
    });
    const res = await handler(
      postRequest(
        { authorization: "Bearer tok", "content-type": "application/json" },
        { clinicId: CLINIC, type: "invoice", cursor: -1 },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("400 sur cursor non entier", async () => {
    const handler = createSyncBlocksHandler({
      verifyToken: async () => okCtx,
      reserve: async () => ({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC }),
    });
    const res = await handler(
      postRequest(
        { authorization: "Bearer tok", "content-type": "application/json" },
        { clinicId: CLINIC, type: "invoice", cursor: 12.5 },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("403 clinic hors portée", async () => {
    const handler = createSyncBlocksHandler({
      verifyToken: async () => okCtx, // clinicIds = [CLINIC]
      reserve: async () => ({ blockStart: 1, blockEnd: 50, type: "invoice", clinicId: CLINIC }),
    });
    const res = await handler(
      postRequest(
        { authorization: "Bearer tok", "content-type": "application/json" },
        { clinicId: "clinic-zzz", type: "invoice" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("200 chemin nominal : reserve reçoit size par défaut et cursor transmis", async () => {
    let seenCursor: number | undefined;
    let seenSize: number | undefined;
    const handler = createSyncBlocksHandler({
      verifyToken: async () => okCtx,
      reserve: async (_ctx, params) => {
        seenCursor = params.cursor;
        seenSize = params.size;
        return { blockStart: 51, blockEnd: 100, type: params.type, clinicId: params.clinicId };
      },
    });
    const res = await handler(
      postRequest(
        { authorization: "Bearer tok", "content-type": "application/json" },
        { clinicId: CLINIC, type: "invoice", cursor: 50 },
      ),
    );
    expect(res.status).toBe(200);
    expect(seenCursor).toBe(50);
    expect(seenSize).toBe(50); // DEFAULT_BLOCK_SIZE
    await expect(res.json()).resolves.toEqual({
      blockStart: 51,
      blockEnd: 100,
      type: "invoice",
      clinicId: CLINIC,
    });
  });
});
