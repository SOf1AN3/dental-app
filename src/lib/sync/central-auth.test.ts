import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  MAX_TRUST_DAYS,
  MIN_TRUST_DAYS,
  hashDeviceToken,
  issueDeviceToken,
  verifyDeviceToken,
  type CentralAuthDeviceRecord,
  type CentralAuthRepo,
  type CentralAuthUser,
} from "./central-auth";

/**
 * Tests **hermétiques** (repo mémoire, aucun réseau, aucune base) du jeton
 * d'appareil central — tâche 5.2a.
 *
 * `verifyPassword` est ici `bcrypt.compare` directement (même primitive que
 * `src/lib/auth-utils.ts`) : le repo Drizzle réel délègue à `auth-utils` via un
 * import dynamique, inaccessible hors bundler Next — voir l'en-tête de
 * `central-auth.ts`. La logique testée (orchestration, échec fermé,
 * anti-énumération) est donc exactement celle de production.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Repo mémoire                                                                */
/* -------------------------------------------------------------------------- */

interface MemoryState {
  users: Map<string, CentralAuthUser & { email: string }>;
  /** userId → clinicIds actifs. */
  memberships: Map<string, string[]>;
  /** tokenHash → ligne device. */
  devicesByHash: Map<string, CentralAuthDeviceRecord>;
  /** Dernier upsert reçu (pour assertions). */
  lastUpsert: {
    deviceId: string;
    userId: string;
    tokenHash: string;
    trustExpiresAt: Date;
  } | null;
}

function createMemoryRepo(seed?: {
  users?: Array<CentralAuthUser & { email: string }>;
  memberships?: Record<string, string[]>;
}): { repo: CentralAuthRepo; state: MemoryState } {
  const state: MemoryState = {
    users: new Map(),
    memberships: new Map(),
    devicesByHash: new Map(),
    lastUpsert: null,
  };
  for (const u of seed?.users ?? []) state.users.set(u.email, u);
  for (const [uid, cids] of Object.entries(seed?.memberships ?? {})) {
    state.memberships.set(uid, cids);
  }

  const repo: CentralAuthRepo = {
    async findUserByEmail(email) {
      return state.users.get(email) ?? null;
    },
    async listUserClinicIds(userId) {
      return state.memberships.get(userId) ?? [];
    },
    // Même primitive bcrypt que `verifyPassword` d'auth-utils.
    async verifyPassword(password, hash) {
      return bcrypt.compare(password, hash);
    },
    async upsertDeviceToken(input) {
      state.lastUpsert = {
        deviceId: input.deviceId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        trustExpiresAt: input.trustExpiresAt,
      };
      state.devicesByHash.set(input.tokenHash, {
        id: input.deviceId,
        userId: input.userId,
        clinicId: null,
        trustExpiresAt: input.trustExpiresAt,
        trustRevokedAt: null,
        tokenHash: input.tokenHash,
      });
    },
    async findDeviceByTokenHash(tokenHash) {
      return state.devicesByHash.get(tokenHash) ?? null;
    },
  };
  return { repo, state };
}

/** Hash bcrypt coût bas (test) d'un mot de passe en clair. */
function hashOf(password: string): string {
  return bcrypt.hashSync(password, 4);
}

/* -------------------------------------------------------------------------- */
/* 1. hashDeviceToken                                                          */
/* -------------------------------------------------------------------------- */

describe("hashDeviceToken", () => {
  it("est déterministe : même entrée → même hash", () => {
    const t = "mon-jeton-abc";
    expect(hashDeviceToken(t)).toBe(hashDeviceToken(t));
  });

  it("produit un SHA-256 hex de 64 caractères", () => {
    expect(hashDeviceToken("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ne contient JAMAIS l'image du jeton en clair", () => {
    const token = "secret-jeton-12345";
    const hash = hashDeviceToken(token);
    expect(hash).not.toContain(token);
    expect(hash).not.toBe(token);
  });

  it("distingue deux jetons différents", () => {
    expect(hashDeviceToken("a")).not.toBe(hashDeviceToken("b"));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. verifyDeviceToken                                                        */
/* -------------------------------------------------------------------------- */

describe("verifyDeviceToken", () => {
  const USER = "user-1";
  const DEVICE = "device-1";
  const CLINICS = ["clinic-a", "clinic-b"];

  function seedValidDevice(): {
    repo: CentralAuthRepo;
    state: MemoryState;
    token: string;
  } {
    const token = "jeton-valide-XYZ_123";
    const tokenHash = hashDeviceToken(token);
    const record: CentralAuthDeviceRecord = {
      id: DEVICE,
      userId: USER,
      clinicId: "clinic-a",
      trustExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      trustRevokedAt: null,
      tokenHash,
    };
    const { repo, state } = createMemoryRepo({
      memberships: { [USER]: CLINICS },
    });
    state.devicesByHash.set(tokenHash, record);
    return { repo, state, token };
  }

  it("retourne le contexte complet pour un jeton valide", async () => {
    const { repo, token } = seedValidDevice();
    const ctx = await verifyDeviceToken(token, NOW, repo);
    expect(ctx).not.toBeNull();
    expect(ctx?.deviceId).toBe(DEVICE);
    expect(ctx?.userId).toBe(USER);
    expect(ctx?.clinicIds).toEqual(CLINICS);
    expect(ctx?.trustExpiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });

  it("token inconnu → null", async () => {
    const { repo } = seedValidDevice();
    expect(await verifyDeviceToken("jeton-inexistant", NOW, repo)).toBeNull();
  });

  it("jeton vide ou malformé → null sans requête", async () => {
    const { repo } = seedValidDevice();
    expect(await verifyDeviceToken("", NOW, repo)).toBeNull();
    expect(await verifyDeviceToken("espace interdit!", NOW, repo)).toBeNull();
    expect(await verifyDeviceToken("a/b+c=d", NOW, repo)).toBeNull();
  });

  it("appareil révoqué → null (la révocation prime même si non expiré)", async () => {
    const { repo, state, token } = seedValidDevice();
    const rec = state.devicesByHash.get(hashDeviceToken(token))!;
    state.devicesByHash.set(hashDeviceToken(token), {
      ...rec,
      trustRevokedAt: new Date(NOW.getTime() - 1000),
    });
    expect(await verifyDeviceToken(token, NOW, repo)).toBeNull();
  });

  it("trustExpiresAt passé → null (fail-closed)", async () => {
    const { repo, state, token } = seedValidDevice();
    const rec = state.devicesByHash.get(hashDeviceToken(token))!;
    state.devicesByHash.set(hashDeviceToken(token), {
      ...rec,
      trustExpiresAt: new Date(NOW.getTime() - 1),
    });
    expect(await verifyDeviceToken(token, NOW, repo)).toBeNull();
  });

  it("trustExpiresAt nul → null (fail-closed)", async () => {
    const { repo, state, token } = seedValidDevice();
    const rec = state.devicesByHash.get(hashDeviceToken(token))!;
    state.devicesByHash.set(hashDeviceToken(token), { ...rec, trustExpiresAt: null });
    expect(await verifyDeviceToken(token, NOW, repo)).toBeNull();
  });

  it("userId nul (compte supprimé) → null", async () => {
    const { repo, state, token } = seedValidDevice();
    const rec = state.devicesByHash.get(hashDeviceToken(token))!;
    state.devicesByHash.set(hashDeviceToken(token), { ...rec, userId: null });
    expect(await verifyDeviceToken(token, NOW, repo)).toBeNull();
  });

  it("moment exact de l'expiration → null (>= expiresAt)", async () => {
    const { repo, state, token } = seedValidDevice();
    const expiresAt = new Date(NOW.getTime() + 5000);
    const rec = state.devicesByHash.get(hashDeviceToken(token))!;
    state.devicesByHash.set(hashDeviceToken(token), { ...rec, trustExpiresAt: expiresAt });
    // now == expiresAt → expiré.
    expect(await verifyDeviceToken(token, expiresAt, repo)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. issueDeviceToken                                                         */
/* -------------------------------------------------------------------------- */

describe("issueDeviceToken", () => {
  const PASSWORD = "mot-de-passe juste";
  const USER = "user-1";

  function seededRepo(): {
    repo: CentralAuthRepo;
    state: MemoryState;
  } {
    return createMemoryRepo({
      users: [{ id: USER, email: "a@b.c", passwordHash: hashOf(PASSWORD) }],
      memberships: { [USER]: ["clinic-a"] },
    });
  }

  const baseParams = {
    email: "a@b.c",
    password: PASSWORD,
    deviceId: "device-1",
    deviceName: "poste-bureau",
    os: "win32",
    trustDays: 30,
    now: NOW,
  };

  it("émet un jeton et calcule trustExpiresAt = now + trustDays", async () => {
    const { repo, state } = seededRepo();
    const res = await issueDeviceToken(baseParams, repo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trustExpiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    expect(typeof res.token).toBe("string");
    expect(res.token.length).toBeGreaterThan(20);
    expect(state.lastUpsert?.trustExpiresAt).toEqual(res.trustExpiresAt);
  });

  it("stocke un token_hash DIFFÉRENT du jeton retourné", async () => {
    const { repo, state } = seededRepo();
    const res = await issueDeviceToken(baseParams, repo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(state.lastUpsert?.tokenHash).not.toBe(res.token);
    expect(state.lastUpsert?.tokenHash).toBe(hashDeviceToken(res.token));
  });

  it("deux émissions successives produisent deux jetons distincts", async () => {
    const { repo } = seededRepo();
    const r1 = await issueDeviceToken(baseParams, repo);
    const r2 = await issueDeviceToken(baseParams, repo);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.token).not.toBe(r2.token);
  });

  // Anti-énumération : raison IDENTIQUE pour email inexistant et mauvais mdp.
  it("mauvais mot de passe → invalid-credentials", async () => {
    const { repo } = seededRepo();
    const res = await issueDeviceToken({ ...baseParams, password: "faux" }, repo);
    expect(res).toEqual({ ok: false, reason: "invalid-credentials" });
  });

  it("email inexistant → invalid-credentials (IDENTIQUE : test d'énumération)", async () => {
    const { repo } = seededRepo();
    const res = await issueDeviceToken(
      { ...baseParams, email: "inconnu@x.y" },
      repo,
    );
    expect(res).toEqual({ ok: false, reason: "invalid-credentials" });
  });

  it("compte sans membership → no-membership", async () => {
    const { repo } = createMemoryRepo({
      users: [{ id: USER, email: "a@b.c", passwordHash: hashOf(PASSWORD) }],
      memberships: { [USER]: [] },
    });
    const res = await issueDeviceToken(baseParams, repo);
    expect(res).toEqual({ ok: false, reason: "no-membership" });
  });

  it("trustDays hors bornes → invalid-trust-days", async () => {
    const { repo } = seededRepo();
    for (const bad of [0, -1, MIN_TRUST_DAYS - 1, MAX_TRUST_DAYS + 1, 3.5]) {
      const res = await issueDeviceToken({ ...baseParams, trustDays: bad }, repo);
      expect(res).toEqual({ ok: false, reason: "invalid-trust-days" });
    }
  });

  it("trustDays aux bornes exactes → accepté", async () => {
    const { repo } = seededRepo();
    const lo = await issueDeviceToken({ ...baseParams, trustDays: MIN_TRUST_DAYS }, repo);
    const hi = await issueDeviceToken({ ...baseParams, trustDays: MAX_TRUST_DAYS }, repo);
    expect(lo.ok).toBe(true);
    expect(hi.ok).toBe(true);
  });

  it("champs vides → invalid-request", async () => {
    const { repo } = seededRepo();
    const res = await issueDeviceToken(
      { ...baseParams, deviceId: "   " },
      repo,
    );
    expect(res).toEqual({ ok: false, reason: "invalid-request" });
  });

  it("flux complet : émission puis vérification du jeton", async () => {
    const { repo } = seededRepo();
    const issued = await issueDeviceToken(baseParams, repo);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const ctx = await verifyDeviceToken(issued.token, NOW, repo);
    expect(ctx).not.toBeNull();
    expect(ctx?.userId).toBe(USER);
    expect(ctx?.clinicIds).toEqual(["clinic-a"]);
    expect(ctx?.trustExpiresAt).toEqual(issued.trustExpiresAt);
  });
});
