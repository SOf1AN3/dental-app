import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRUST_TTL_MS,
  checkTrust,
  evaluateTrust,
  grantTrust,
  isCentralReachable,
  revokeTrustLocally,
  type DeviceTrustRecord,
  type DeviceTrustRepo,
} from "./device-trust";

/** Repo en mémoire : aucune base, aucun réseau — tests hermétiques (D-8). */
interface MemoryRepo extends DeviceTrustRepo {
  readonly rows: Map<string, DeviceTrustRecord>;
}

function createMemoryRepo(seed?: DeviceTrustRecord): MemoryRepo {
  const rows = new Map<string, DeviceTrustRecord>();
  if (seed) rows.set(seed.id, seed);
  return {
    rows,
    async get(deviceId) {
      return rows.get(deviceId) ?? null;
    },
    async upsert(deviceId, patch) {
      const existing = rows.get(deviceId);
      const stamp = patch.lastSeenAt ?? new Date();
      const base: DeviceTrustRecord = existing ?? {
        id: deviceId,
        userId: null,
        clinicId: null,
        name: "unknown-host",
        os: "unknown",
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        trustExpiresAt: null,
        trustRevokedAt: null,
      };
      const next: DeviceTrustRecord = {
        ...base,
        ...patch,
        id: deviceId,
        // Contrat du repo : firstSeenAt est inaltéré sur une ligne existante.
        firstSeenAt: base.firstSeenAt,
      };
      rows.set(deviceId, next);
      return next;
    },
    async touch(deviceId, at) {
      const existing = rows.get(deviceId);
      if (!existing) return;
      rows.set(deviceId, { ...existing, lastSeenAt: at });
    },
  };
}

const USER_A = "user-a";
const USER_B = "user-b";
const DEVICE_1 = "device-1";
const T0 = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function makeRecord(overrides: Partial<DeviceTrustRecord> & { id: string }): DeviceTrustRecord {
  return {
    userId: USER_A,
    clinicId: "clinic-1",
    name: "poste-01",
    os: "win32",
    firstSeenAt: T0,
    lastSeenAt: T0,
    trustExpiresAt: new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS),
    trustRevokedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Étanchéité réseau des tests : pose d'abord un `fetch` **stubé** (fonction
 * no-op), puis un spy dessus. Si le garde-fou SSRF régressait, l'appel part
 * donc dans le stub — **jamais un vrai `fetch`** — avant l'assertion.
 * Restauré par l'`afterEach` (`vi.unstubAllGlobals()` + `vi.restoreAllMocks()`).
 */
function stubFetchSpy() {
  vi.stubGlobal("fetch", vi.fn());
  return vi.spyOn(globalThis, "fetch");
}

describe("evaluateTrust (pur)", () => {
  it("refuse un device inconnu : missing", () => {
    expect(evaluateTrust(null, USER_A, NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("accorde la confiance d'un device valide et renvoie l'expiration", () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    const record = makeRecord({ id: DEVICE_1, trustExpiresAt: expiresAt });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: true, expiresAt });
  });

  it("refuse quand trustExpiresAt est nul : expired", () => {
    const record = makeRecord({ id: DEVICE_1, trustExpiresAt: null });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse quand la fenêtre est dépassée : expired", () => {
    const record = makeRecord({ id: DEVICE_1, trustExpiresAt: new Date(NOW.getTime() - 1) });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("révocation prime sur une date encore valide : revoked", () => {
    const record = makeRecord({
      id: DEVICE_1,
      trustRevokedAt: new Date("2026-05-01T00:00:00.000Z"),
      trustExpiresAt: new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS),
    });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuse un compte différent : user-mismatch", () => {
    const record = makeRecord({ id: DEVICE_1, userId: USER_A });
    expect(evaluateTrust(record, USER_B, NOW)).toEqual({ ok: false, reason: "user-mismatch" });
  });

  it("priorité : revoked avant expired et user-mismatch", () => {
    const record = makeRecord({
      id: DEVICE_1,
      userId: USER_B,
      trustExpiresAt: new Date(NOW.getTime() - 1),
      trustRevokedAt: NOW,
    });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("horloge fausse (NaN) → expired déterministe, aucune exception", () => {
    const record = makeRecord({ id: DEVICE_1, trustExpiresAt: new Date("invalid") });
    expect(evaluateTrust(record, USER_A, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(evaluateTrust(record, USER_A, new Date(NaN))).toEqual({ ok: false, reason: "expired" });
  });
});

describe("grantTrust", () => {
  it("ouvre la confiance d'un device inconnu : ok, expiration posée", async () => {
    const repo = createMemoryRepo();
    const decision = await grantTrust(
      repo,
      { deviceId: DEVICE_1, userId: USER_A, name: "poste-01", os: "win32" },
      NOW,
    );
    expect(decision).toEqual({ ok: true, expiresAt: new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS) });
    const stored = await repo.get(DEVICE_1);
    expect(stored?.trustExpiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS));
    expect(stored?.userId).toBe(USER_A);
    expect(stored?.firstSeenAt).toEqual(NOW);
  });

  it("renouvelle un device existant : date repoussée, firstSeenAt préservé", async () => {
    const firstSeen = new Date("2025-01-01T00:00:00.000Z");
    const seed = makeRecord({
      id: DEVICE_1,
      firstSeenAt: firstSeen,
      trustExpiresAt: new Date("2026-06-15T00:00:00.000Z"),
    });
    const repo = createMemoryRepo(seed);
    const decision = await grantTrust(repo, { deviceId: DEVICE_1, userId: USER_A }, NOW);
    expect(decision.ok).toBe(true);
    const stored = await repo.get(DEVICE_1);
    expect(stored?.trustExpiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS));
    expect(stored?.firstSeenAt).toEqual(firstSeen);
    expect(repo.rows.size).toBe(1);
  });

  it("n'efface pas un clinicId déjà connu quand le paramètre est omis", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1, clinicId: "clinic-42" }));
    await grantTrust(repo, { deviceId: DEVICE_1, userId: USER_A }, NOW);
    expect((await repo.get(DEVICE_1))?.clinicId).toBe("clinic-42");
  });

  it("autorise le transfert vers un autre compte lors d'un échange en ligne", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1, userId: USER_A }));
    const decision = await grantTrust(repo, { deviceId: DEVICE_1, userId: USER_B }, NOW);
    expect(decision).toEqual({ ok: true, expiresAt: new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS) });
    expect((await repo.get(DEVICE_1))?.userId).toBe(USER_B);
  });

  it("ne lève jamais une révocation existante (aucune écriture)", async () => {
    const revokedAt = new Date("2026-05-01T00:00:00.000Z");
    const seed = makeRecord({ id: DEVICE_1, trustRevokedAt: revokedAt });
    const repo = createMemoryRepo(seed);
    const decision = await grantTrust(repo, { deviceId: DEVICE_1, userId: USER_A }, NOW);
    expect(decision).toEqual({ ok: false, reason: "revoked" });
    const stored = await repo.get(DEVICE_1);
    expect(stored?.trustRevokedAt).toEqual(revokedAt);
    expect(stored?.trustExpiresAt).toEqual(seed.trustExpiresAt);
  });

  it("horloge fausse : déterministe, aucune exception (passé et futur)", async () => {
    const repo = createMemoryRepo();
    const past = new Date("1970-01-01T00:00:00.000Z");
    const pastDecision = await grantTrust(repo, { deviceId: DEVICE_1, userId: USER_A }, past);
    expect(pastDecision).toEqual({ ok: true, expiresAt: new Date(past.getTime() + DEFAULT_TRUST_TTL_MS) });

    const future = new Date("2999-01-01T00:00:00.000Z");
    const futureDecision = await grantTrust(
      createMemoryRepo(),
      { deviceId: "device-2", userId: USER_A },
      future,
    );
    expect(futureDecision).toEqual({ ok: true, expiresAt: new Date(future.getTime() + DEFAULT_TRUST_TTL_MS) });

    // Une confiance ouverte dans le passé lointain est expirée pour une horloge réelle.
    expect(await checkTrust(repo, DEVICE_1, USER_A, NOW)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("checkTrust", () => {
  it("accorde un device enregistré et trace la tentative (lastSeenAt)", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1 }));
    const later = new Date(NOW.getTime() + 60_000);
    expect(await checkTrust(repo, DEVICE_1, USER_A, later)).toEqual({
      ok: true,
      expiresAt: new Date(NOW.getTime() + DEFAULT_TRUST_TTL_MS),
    });
    expect((await repo.get(DEVICE_1))?.lastSeenAt).toEqual(later);
  });

  it("refuse un device inconnu : missing (sans écriture)", async () => {
    const repo = createMemoryRepo();
    expect(await checkTrust(repo, DEVICE_1, USER_A, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(repo.rows.size).toBe(0);
  });

  it("refuse un device expiré : expired", async () => {
    const seed = makeRecord({ id: DEVICE_1, trustExpiresAt: new Date(NOW.getTime() - 1) });
    const repo = createMemoryRepo(seed);
    expect(await checkTrust(repo, DEVICE_1, USER_A, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse un device révoqué même hors expiration : revoked", async () => {
    const seed = makeRecord({ id: DEVICE_1, trustRevokedAt: new Date(NOW.getTime() - 1000) });
    const repo = createMemoryRepo(seed);
    expect(await checkTrust(repo, DEVICE_1, USER_A, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuse un compte différent : user-mismatch", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1, userId: USER_A }));
    expect(await checkTrust(repo, DEVICE_1, USER_B, NOW)).toEqual({ ok: false, reason: "user-mismatch" });
  });
});

describe("revokeTrustLocally", () => {
  it("révoque localement un device connu", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1 }));
    await revokeTrustLocally(repo, DEVICE_1, NOW);
    expect(await checkTrust(repo, DEVICE_1, USER_A, NOW)).toEqual({ ok: false, reason: "revoked" });
    expect((await repo.get(DEVICE_1))?.trustRevokedAt).toEqual(NOW);
  });

  it("révocation idempotente : conserve la date d'origine", async () => {
    const repo = createMemoryRepo(makeRecord({ id: DEVICE_1 }));
    await revokeTrustLocally(repo, DEVICE_1, NOW);
    const later = new Date(NOW.getTime() + 1000);
    await revokeTrustLocally(repo, DEVICE_1, later);
    expect((await repo.get(DEVICE_1))?.trustRevokedAt).toEqual(NOW);
    expect(repo.rows.size).toBe(1);
  });

  it("device inconnu : no-op, aucune ligne fantôme", async () => {
    const repo = createMemoryRepo();
    await revokeTrustLocally(repo, DEVICE_1, NOW);
    expect(repo.rows.size).toBe(0);
    expect(await repo.get(DEVICE_1)).toBeNull();
  });
});

/** Origine du serveur central utilisée par les tests (cf. `SYNC_BASE_URL`). */
const CENTRAL = "https://central.example";

describe("isCentralReachable", () => {
  it("env SYNC_BASE_URL absente → false, même avec une URL en paramètre, zéro appel fetch", async () => {
    const fetchSpy = stubFetchSpy();
    await expect(isCentralReachable("https://central.example")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("env SYNC_BASE_URL malformée ou protocole non http(s) → false sans appel réseau", async () => {
    const fetchSpy = stubFetchSpy();
    vi.stubEnv("SYNC_BASE_URL", "pas-une-url");
    await expect(isCentralReachable("https://central.example")).resolves.toBe(false);
    vi.stubEnv("SYNC_BASE_URL", "file:///opt/central");
    await expect(isCentralReachable("https://central.example")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("baseUrl undefined → false sans aucun appel réseau", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    const fetchSpy = stubFetchSpy();
    await expect(isCentralReachable(undefined)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("URL malformée ou protocole non supporté → false sans appel réseau", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    const fetchSpy = stubFetchSpy();
    await expect(isCentralReachable("pas-une-url")).resolves.toBe(false);
    await expect(isCentralReachable("ftp://central.example")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("garde-fou SSRF : origine différente de SYNC_BASE_URL → false, zéro appel fetch", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    const fetchSpy = stubFetchSpy();
    await expect(isCentralReachable("https://evil.example")).resolves.toBe(false);
    // Schéma différent (http vs https) : l'origine diffère.
    await expect(isCentralReachable("http://central.example")).resolves.toBe(false);
    // Port explicite différent : l'origine diffère.
    await expect(isCentralReachable("https://central.example:8443")).resolves.toBe(false);
    // Sous-domaine / suffixe trompeur : l'origine diffère.
    await expect(isCentralReachable("https://central.example.attacker.net")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("garde-fou SSRF : schémas file:/javascript: et hôtes internes → false, zéro appel fetch", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    const fetchSpy = stubFetchSpy();
    await expect(isCentralReachable("file:///etc/passwd")).resolves.toBe(false);
    await expect(isCentralReachable("javascript:alert(1)")).resolves.toBe(false);
    // Métadonnées cloud et boucleback : refusés car origines différentes de l'env.
    await expect(isCentralReachable("https://169.254.169.254/latest/meta-data/")).resolves.toBe(false);
    await expect(isCentralReachable("https://localhost/admin")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("réseau absent / DNS en échec → false (ne lève jamais)", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("getaddrinfo ENOTFOUND central")));
    await expect(isCentralReachable("https://central.example")).resolves.toBe(false);
  });

  it("réponse HTTP reçue, même en erreur serveur → true (joignable)", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 500 })));
    await expect(isCentralReachable("https://central.example")).resolves.toBe(true);
  });

  it("timeout borné : abort → false, sans exception", async () => {
    vi.stubEnv("SYNC_BASE_URL", CENTRAL);
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const pending = isCentralReachable("https://central.example", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(false);
  });
});
