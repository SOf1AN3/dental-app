import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkTokenThrottle,
  recordTokenAttempt,
  type TokenThrottleAttempt,
  type TokenThrottleInsertParams,
  type TokenThrottleListParams,
  type TokenThrottleRecordParams,
  type TokenThrottleRepo,
} from "./token-throttle";

/**
 * Tests **hermétiques** du throttle de `POST /api/sync/token` (tâche 5.2d).
 *
 * Repo mémoire uniquement : aucune base PostgreSQL, aucun appel réseau (vérifié
 * explicitement par un spy sur `fetch`). Le repo Drizzle
 * (`createTokenThrottleDbRepo`) n'est jamais instancié ici.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Repo mémoire                                                                */
/* -------------------------------------------------------------------------- */

/** Ligne mémoire : `TokenThrottleAttempt` + le motif, pour assertions forensiques. */
interface MemoryAttempt extends TokenThrottleAttempt {
  readonly deniedReason: string | null;
}

interface MemoryRepo extends TokenThrottleRepo {
  readonly rows: MemoryAttempt[];
  readonly inserts: readonly TokenThrottleInsertParams[];
  readonly lastListParams: TokenThrottleListParams | null;
}

function createMemoryRepo(seed: MemoryAttempt[] = []): MemoryRepo {
  const rows: MemoryAttempt[] = [...seed];
  const inserts: TokenThrottleInsertParams[] = [];
  const state: { lastListParams: TokenThrottleListParams | null } = {
    lastListParams: null,
  };

  const repo: MemoryRepo = {
    rows,
    inserts,
    get lastListParams() {
      return state.lastListParams;
    },
    async purgeAttemptsOlderThan(cutoff: Date) {
      // Retire sur place (comme le DELETE SQL) sans toucher aux autres lignes.
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].createdAt < cutoff) rows.splice(i, 1);
      }
    },
    async listRecentAttempts(params) {
      state.lastListParams = params;
      return rows
        .filter(
          (row) =>
            row.createdAt > params.since &&
            (row.email === params.email ||
              (params.ipAddress !== undefined &&
                row.ipAddress === params.ipAddress)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, params.limit);
    },
    async insertAttempt(params) {
      inserts.push(params);
      rows.push({
        email: params.email,
        ipAddress: params.ipAddress ?? null,
        successful: params.successful,
        deniedReason: params.deniedReason,
        createdAt: params.createdAt,
      });
    },
  };
  return repo;
}

const EMAIL = "dentiste@cabinet.dz";
const IP = "203.0.113.7";
const WINDOW_MS = 15 * 60 * 1000;

function failure(email: string, createdAt: Date, ipAddress: string | null = IP): MemoryAttempt {
  return { email, ipAddress, successful: false, deniedReason: "sync-token:invalid-credentials", createdAt };
}

function recordParams(overrides: Partial<TokenThrottleRecordParams> = {}): TokenThrottleRecordParams {
  return {
    email: EMAIL,
    ipAddress: IP,
    successful: false,
    deniedReason: "sync-token:invalid-credentials",
    now: new Date(),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Plafond par compte                                                          */
/* -------------------------------------------------------------------------- */

describe("checkTokenThrottle — plafond par compte (5 échecs / 15 min)", () => {
  it("autorise tant que le compte reste sous 5 échecs", async () => {
    const now = new Date();
    const repo = createMemoryRepo(
      Array.from({ length: 4 }, (_, i) =>
        failure(EMAIL, new Date(now.getTime() - (i + 1) * 60_000)),
      ),
    );

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("bloque dès le 5ᵉ échec (reason: account)", async () => {
    const now = new Date();
    const repo = createMemoryRepo(
      Array.from({ length: 5 }, (_, i) =>
        failure(EMAIL, new Date(now.getTime() - (i + 1) * 60_000)),
      ),
    );

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });

    expect(decision).toEqual({ allowed: false, reason: "account" });
  });

  it("un SUCCÈS réinitialise le compteur du compte", async () => {
    const now = new Date();
    const rows: MemoryAttempt[] = [
      // 5 échecs...
      ...Array.from({ length: 5 }, (_, i) =>
        failure(EMAIL, new Date(now.getTime() - (10 + i) * 60_000)),
      ),
      // ...puis un succès PLUS RÉCENT (le plus récent prime, en ordre décroissant).
      {
        email: EMAIL,
        ipAddress: IP,
        successful: true,
        deniedReason: null,
        createdAt: new Date(now.getTime() - 60_000),
      },
    ];
    const repo = createMemoryRepo(rows);

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });

    expect(decision.allowed).toBe(true);
  });

  it("une seule lecture bornée (≤ 500 lignes) porte les deux décomptes", async () => {
    const now = new Date();
    const repo = createMemoryRepo();

    await checkTokenThrottle(repo, { email: EMAIL, ipAddress: IP, now });

    expect(repo.lastListParams).not.toBeNull();
    expect(repo.lastListParams?.limit).toBe(500);
    expect(repo.lastListParams?.email).toBe(EMAIL);
    expect(repo.lastListParams?.ipAddress).toBe(IP);
  });
});

/* -------------------------------------------------------------------------- */
/* Plafond par IP                                                             */
/* -------------------------------------------------------------------------- */

describe("checkTokenThrottle — plafond par IP (50 échecs / 15 min)", () => {
  it("bloque un email neuf si son IP a déjà 50 échecs (reason: ip)", async () => {
    const now = new Date();
    // 50 échecs sur 50 comptes DISTINCTS : seul le plafond IP peut agir.
    const repo = createMemoryRepo(
      Array.from({ length: 50 }, (_, i) =>
        failure(`spam-${i}@example.com`, new Date(now.getTime() - (i + 1) * 1_000)),
      ),
    );

    const decision = await checkTokenThrottle(repo, {
      email: "victime@example.com",
      ipAddress: IP,
      now,
    });

    expect(decision).toEqual({ allowed: false, reason: "ip" });
  });

  it("le même email depuis une autre IP reste autorisé (plafonds indépendants)", async () => {
    const now = new Date();
    const repo = createMemoryRepo(
      Array.from({ length: 50 }, (_, i) =>
        failure(`spam-${i}@example.com`, new Date(now.getTime() - (i + 1) * 1_000)),
      ),
    );

    const decision = await checkTokenThrottle(repo, {
      email: "victime@example.com",
      ipAddress: "198.51.100.9",
      now,
    });

    expect(decision.allowed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Fenêtre glissante                                                          */
/* -------------------------------------------------------------------------- */

describe("checkTokenThrottle — fenêtre glissante", () => {
  it("une tentative vieille de 16 min ne compte plus", async () => {
    const now = new Date();
    const repo = createMemoryRepo([
      // 5 échecs au total, mais le premier est SORTI de la fenêtre de 15 min.
      failure(EMAIL, new Date(now.getTime() - WINDOW_MS - 60_000)), // -16 min
      failure(EMAIL, new Date(now.getTime() - 8 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 6 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 4 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 2 * 60_000)),
    ]);

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });

    // Seuls 4 échecs restent dans la fenêtre → autorisé.
    expect(decision.allowed).toBe(true);
  });

  it("le 5ᵉ échec encore dans la fenêtre bloque à nouveau", async () => {
    const now = new Date();
    const repo = createMemoryRepo([
      failure(EMAIL, new Date(now.getTime() - WINDOW_MS - 60_000)), // -16 min
      failure(EMAIL, new Date(now.getTime() - 8 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 6 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 4 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 2 * 60_000)),
      failure(EMAIL, new Date(now.getTime() - 30_000)),
    ]);

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });

    expect(decision).toEqual({ allowed: false, reason: "account" });
  });
});

/* -------------------------------------------------------------------------- */
/* Journalisation forensique                                                  */
/* -------------------------------------------------------------------------- */

describe("recordTokenAttempt", () => {
  it("journalise un échec avec le VRAI email et deniedReason sync-token:", async () => {
    const repo = createMemoryRepo();
    const now = new Date();

    await recordTokenAttempt(repo, {
      email: EMAIL,
      ipAddress: IP,
      successful: false,
      deniedReason: "sync-token:invalid-credentials",
      now,
    });

    expect(repo.inserts).toHaveLength(1);
    expect(repo.inserts[0]).toEqual({
      email: EMAIL,
      ipAddress: IP,
      successful: false,
      deniedReason: "sync-token:invalid-credentials",
      createdAt: now,
    });
    // La ligne est relisible par le décompte (journal partagé avec auth.ts).
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].email).toBe(EMAIL);
  });

  it("journalise un blocage (sync-token:throttled, successful: false)", async () => {
    const repo = createMemoryRepo();
    const now = new Date();

    await recordTokenAttempt(repo, recordParams({
      successful: false,
      deniedReason: "sync-token:throttled",
      now,
    }));

    expect(repo.inserts[0].successful).toBe(false);
    expect(repo.inserts[0].deniedReason).toBe("sync-token:throttled");
  });

  it("normalise une IP absente en null (colonne nullable)", async () => {
    const repo = createMemoryRepo();
    const now = new Date();

    await recordTokenAttempt(repo, {
      email: EMAIL,
      ipAddress: undefined,
      successful: true,
      now,
    });

    expect(repo.inserts[0].ipAddress).toBeUndefined();
    expect(repo.rows[0].ipAddress).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Hermétisme                                                                 */
/* -------------------------------------------------------------------------- */

describe("hermétisme", () => {
  it("n'effectue AUCUN appel réseau (fetch) sur un cycle complet", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const now = new Date();
    const repo = createMemoryRepo(
      Array.from({ length: 5 }, (_, i) =>
        failure(EMAIL, new Date(now.getTime() - (i + 1) * 60_000)),
      ),
    );

    const decision = await checkTokenThrottle(repo, {
      email: EMAIL,
      ipAddress: IP,
      now,
    });
    await recordTokenAttempt(repo, recordParams({
      deniedReason: "sync-token:throttled",
      now,
    }));

    expect(decision.allowed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
