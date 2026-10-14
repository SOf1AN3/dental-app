import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as healthGET } from "@/app/api/health/route";
import {
  createSyncTokenHandler,
  resolveClientIp,
  type SyncTokenHandlerDeps,
} from "@/app/api/sync/token/route";
import { createSyncPushHandler } from "@/app/api/sync/push/route";
import { createSyncPullHandler } from "@/app/api/sync/pull/route";
import { SyncScopeError } from "./central-store";
import type {
  TokenThrottleCheckResult,
  TokenThrottleRecordParams,
} from "./token-throttle";
import {
  hashDeviceToken,
  type CentralAuthDeviceRecord,
  type CentralAuthRepo,
  type CentralAuthUser,
  type DeviceTokenContext,
} from "./central-auth";
import {
  MAX_PUSH_OPS,
  type ChangeOp,
  type PullRequest,
  type PullResponse,
  type PushResponse,
} from "./protocol";

/**
 * Tests **hermétiques** des routes HTTP de synchronisation (tâche 5.2c +
 * limitation de débit de `/api/sync/token`, tâche 5.2d).
 *
 * Les routes exportent une fabrique de handler (`create*Handler(deps)`) dont
 * les deps sont **injectables** : les tests appellent les handlers avec un
 * `Request` fabriqué, **sans serveur, sans base, sans réseau**. Le `POST`
 * exporté par chaque route est le chemin de production (deps Drizzle par
 * défaut), jamais exercé ici.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function postJson(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function errorBody(res: Response): Promise<{ error: string }> {
  return (await res.json()) as { error: string };
}

/* -------------------------------------------------------------------------- */
/* GET /api/health                                                             */
/* -------------------------------------------------------------------------- */

describe("GET /api/health", () => {
  it("répond 200 avec strictement status/time/version (aucun champ sensible)", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "time", "version"]);
    expect(body.status).toBe("ok");
    expect(Number.isFinite(Date.parse(String(body.time)))).toBe(true);
    expect(String(body.version)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/sync/token                                                        */
/* -------------------------------------------------------------------------- */

const PASSWORD = "mot-de-passe-fort";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const USER_ID = "user-A";

interface TokenSeed {
  memberships?: Record<string, string[]>;
  /** Rattachements existants `deviceId → userId` (garde anti-détournement). */
  bindings?: Record<string, string | null>;
}

function createTokenRepo(seed: TokenSeed = {}): {
  repo: CentralAuthRepo;
  upserts: Array<{ deviceId: string; userId: string; tokenHash: string }>;
  devicesByHash: Map<string, CentralAuthDeviceRecord>;
} {
  const upserts: Array<{ deviceId: string; userId: string; tokenHash: string }> =
    [];
  const devicesByHash = new Map<string, CentralAuthDeviceRecord>();
  const user: CentralAuthUser & { email: string } = {
    id: USER_ID,
    email: "ada@example.com",
    passwordHash: PASSWORD_HASH,
  };

  const repo: CentralAuthRepo = {
    async findUserByEmail(email) {
      return email === user.email ? user : null;
    },
    async listUserClinicIds(userId) {
      return userId === USER_ID ? (seed.memberships?.[USER_ID] ?? []) : [];
    },
    async verifyPassword(password, hash) {
      return bcrypt.compare(password, hash);
    },
    async upsertDeviceToken(input) {
      upserts.push({
        deviceId: input.deviceId,
        userId: input.userId,
        tokenHash: input.tokenHash,
      });
      devicesByHash.set(input.tokenHash, {
        id: input.deviceId,
        userId: input.userId,
        clinicId: null,
        trustExpiresAt: input.trustExpiresAt,
        trustRevokedAt: null,
        tokenHash: input.tokenHash,
      });
    },
    async findDeviceByTokenHash(tokenHash) {
      return devicesByHash.get(tokenHash) ?? null;
    },
  };
  return { repo, upserts, devicesByHash };
}

/** Lookup de la garde anti-détournement, piloté par `seed.bindings`. */
function bindingLookup(bindings: Record<string, string | null> = {}) {
  return async (deviceId: string) => {
    const userId = Object.hasOwn(bindings, deviceId)
      ? bindings[deviceId]
      : null;
    return { id: deviceId, userId };
  };
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "ada@example.com",
    password: PASSWORD,
    deviceId: "device-1",
    deviceName: "Poste accueil",
    os: "win32",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Throttle mémoire (tâche 5.2d) — les tests restent hermétiques               */
/* -------------------------------------------------------------------------- */

interface ThrottleHarness {
  /** Deps à étaler dans `createSyncTokenHandler` (aucune base, aucun réseau). */
  deps: Pick<SyncTokenHandlerDeps, "checkThrottle" | "recordAttempt">;
  /** Tentatives réellement journalisées par le handler. */
  attempts: TokenThrottleRecordParams[];
}

/**
 * Fabrique des deps de throttle : `blocked: true` simule un compte/IP déjà
 * bloqué (le handler doit répondre `429` et journaliser le blocage).
 */
function memoryThrottle(
  options: { blocked?: boolean } = {},
): ThrottleHarness {
  const attempts: TokenThrottleRecordParams[] = [];
  return {
    attempts,
    deps: {
      checkThrottle: async (): Promise<TokenThrottleCheckResult> =>
        options.blocked
          ? { allowed: false, reason: "account" }
          : { allowed: true },
      recordAttempt: async (params: TokenThrottleRecordParams): Promise<void> => {
        attempts.push(params);
      },
    },
  };
}

describe("POST /api/sync/token", () => {
  it("400 (invalid-request) quand un champ obligatoire manque", async () => {
    const { repo } = createTokenRepo({ memberships: { [USER_ID]: ["c1"] } });
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...memoryThrottle().deps,
    });

    const res = await handler(postJson({ email: "ada@example.com" }));
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ error: "invalid-request" });
  });

  it("400 (invalid-request) sur un corps vide ou non JSON", async () => {
    const { repo } = createTokenRepo();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...memoryThrottle().deps,
    });

    const res = await handler(new Request("http://localhost/api/test", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ error: "invalid-request" });
  });

  it("400 (invalid-trust-days) sur un trustDays hors bornes", async () => {
    const { repo } = createTokenRepo();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...memoryThrottle().deps,
    });

    const res = await handler(postJson(tokenBody({ trustDays: 0 })));
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ error: "invalid-trust-days" });
  });

  it("401 (invalid-credentials) sur un mauvais mot de passe", async () => {
    const { repo, upserts } = createTokenRepo({
      memberships: { [USER_ID]: ["c1"] },
    });
    const throttle = memoryThrottle();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...throttle.deps,
    });

    const res = await handler(postJson(tokenBody({ password: "faux" })));
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ error: "invalid-credentials" });
    expect(upserts).toHaveLength(0); // aucun jeton émis

    // L'échec est journalisé (forensique) : le compteur d'échecs du compte
    // grimpe, et le login web du même compte en profite (journal partagé).
    expect(throttle.attempts).toHaveLength(1);
    expect(throttle.attempts[0]).toMatchObject({
      email: "ada@example.com",
      successful: false,
      deniedReason: "sync-token:invalid-credentials",
    });
    expect(throttle.attempts[0].now).toBeInstanceOf(Date);
  });

  it("429 (throttled) quand le throttle refuse — et la tentative est journalisée", async () => {
    const { repo, upserts } = createTokenRepo({
      memberships: { [USER_ID]: ["c1"] },
    });
    const throttle = memoryThrottle({ blocked: true });
    const issue = vi.fn();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      issue,
      ...throttle.deps,
    });

    const res = await handler(postJson(tokenBody()));
    expect(res.status).toBe(429);
    expect(await errorBody(res)).toEqual({ error: "throttled" });

    // Échec fermé : bcrypt n'est JAMAIS payé et aucun jeton n'est émis.
    expect(issue).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);

    // Le blocage lui-même est journalisé (successful: false + raison dédiée).
    expect(throttle.attempts).toHaveLength(1);
    expect(throttle.attempts[0]).toMatchObject({
      email: "ada@example.com",
      successful: false,
      deniedReason: "sync-token:throttled",
    });
  });

  it("403 (no-membership) sur un compte sans cabinet actif", async () => {
    const { repo } = createTokenRepo({ memberships: { [USER_ID]: [] } });
    const throttle = memoryThrottle();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...throttle.deps,
    });

    const res = await handler(postJson(tokenBody()));
    expect(res.status).toBe(403);
    expect(await errorBody(res)).toEqual({ error: "no-membership" });
    // Mot de passe VALIDE, refus POLICY : successful=true + denied_reason (le
    // titulaire ne doit pas voir son compteur d'échecs grimper), comme la
    // gate de confiance d'appareil de `auth.ts`.
    expect(throttle.attempts[0]).toMatchObject({
      successful: true,
      deniedReason: "sync-token:no-membership",
    });
  });

  it("403 (device-bound-to-another-user) sans écraser l'appareil d'un autre compte", async () => {
    const { repo, upserts } = createTokenRepo({
      memberships: { [USER_ID]: ["c1"] },
    });
    const throttle = memoryThrottle();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup({ "device-1": "user-B" }),
      ...throttle.deps,
    });

    const res = await handler(postJson(tokenBody()));
    expect(res.status).toBe(403);
    expect(await errorBody(res)).toEqual({
      error: "device-bound-to-another-user",
    });
    // Garde posée AVANT l'upsert : token_hash / user_id intacts.
    expect(upserts).toHaveLength(0);
    // Le mot de passe était POURTANT valide : la ligne n'est pas un échec de
    // brute-force (successful=true + denied_reason), comme `auth.ts`.
    expect(throttle.attempts[0]).toMatchObject({
      successful: true,
      deniedReason: "sync-token:device-bound-to-another-user",
    });
  });

  it("200 avec un jeton renvoyé une seule fois et une fenêtre de confiance serveur", async () => {
    const { repo, upserts, devicesByHash } = createTokenRepo({
      memberships: { [USER_ID]: ["c1"] },
    });
    const throttle = memoryThrottle();
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup({ "device-1": USER_ID }),
      ...throttle.deps,
    });

    const before = Date.now();
    const res = await handler(postJson(tokenBody({ trustDays: 30 })));
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      trustExpiresAt: string;
    };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(Number.isFinite(Date.parse(body.trustExpiresAt))).toBe(true);

    // Fenêtre calculée sur l'horloge SERVEUR : now + 30 j (tolérance 5 min).
    const expiry = Date.parse(body.trustExpiresAt);
    expect(expiry).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(expiry).toBeLessThanOrEqual(after + 30 * 86_400_000 + 300_000);

    // Seul le hash persiste ; le jeton en clair ne figure dans aucune ligne.
    expect(upserts).toHaveLength(1);
    expect(upserts[0].tokenHash).toBe(hashDeviceToken(body.token));
    expect([...devicesByHash.keys()]).toEqual([hashDeviceToken(body.token)]);

    // Le succès est journalisé (`successful = true`, sans denied_reason) : il
    // réinitialise le compteur d'échecs du compte (règle de `auth.ts`).
    expect(throttle.attempts).toHaveLength(1);
    expect(throttle.attempts[0]).toMatchObject({
      email: "ada@example.com",
      successful: true,
    });
    expect(throttle.attempts[0].deniedReason).toBeUndefined();
  });

  it("transmet au throttle le vrai email et la IP (x-forwarded-for)", async () => {
    const { repo } = createTokenRepo({ memberships: { [USER_ID]: ["c1"] } });
    const seen: Array<{ email: string; ipAddress: string | undefined }> = [];
    const handler = createSyncTokenHandler({
      authRepo: repo,
      findDeviceBinding: bindingLookup(),
      ...memoryThrottle().deps,
      checkThrottle: async (params) => {
        seen.push({ email: params.email, ipAddress: params.ipAddress });
        return { allowed: true };
      },
    });

    const res = await handler(
      postJson(tokenBody(), { "x-forwarded-for": "198.51.100.9, 10.0.0.1" }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { email: "ada@example.com", ipAddress: "198.51.100.9" },
    ]);
  });

  describe("resolveClientIp", () => {
    it("prend le premier saut de x-forwarded-for, puis x-real-ip", () => {
      expect(
        resolveClientIp(
          new Request("http://localhost", {
            headers: {
              "x-forwarded-for": "203.0.113.5, 10.0.0.1",
              "x-real-ip": "10.0.0.2",
            },
          }),
        ),
      ).toBe("203.0.113.5");
      expect(
        resolveClientIp(
          new Request("http://localhost", { headers: { "x-real-ip": "10.0.0.2" } }),
        ),
      ).toBe("10.0.0.2");
      expect(resolveClientIp(new Request("http://localhost"))).toBeUndefined();
    });
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/sync/push                                                         */
/* -------------------------------------------------------------------------- */

const CTX: DeviceTokenContext = {
  deviceId: "device-1",
  userId: USER_ID,
  clinicIds: ["c1"],
  trustExpiresAt: new Date("2026-12-31T00:00:00.000Z"),
};

function pushOp(overrides: Partial<ChangeOp> = {}): ChangeOp {
  return {
    opId: crypto.randomUUID(),
    table: "patient",
    rowId: "p1",
    op: "insert",
    payload: { id: "p1", clinicId: "c1", firstName: "Zoé" },
    clinicId: "c1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("POST /api/sync/push", () => {
  it("401 sans en-tête Authorization", async () => {
    const apply = vi.fn();
    const handler = createSyncPushHandler({
      verifyToken: async () => CTX,
      apply,
    });

    const res = await handler(postJson({ deviceId: "device-1", clinicId: "c1", ops: [pushOp()] }));
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ error: "unauthorized" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("401 sur un jeton absent de la base (échec fermé)", async () => {
    const handler = createSyncPushHandler({
      verifyToken: async () => null,
      apply: vi.fn(),
    });

    const res = await handler(
      postJson({ deviceId: "device-1", clinicId: "c1", ops: [pushOp()] }, bearer("jeton-invalide")),
    );
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ error: "unauthorized" });
  });

  it("400 (et non 500) sur un lot plus gros que MAX_PUSH_OPS", async () => {
    const handler = createSyncPushHandler({
      verifyToken: async () => CTX,
      apply: vi.fn(),
    });

    const tooMany = new Array<{ table: string }>(MAX_PUSH_OPS + 1).fill({
      table: "patient",
    });
    const res = await handler(
      postJson(
        { deviceId: "device-1", clinicId: "c1", ops: tooMany },
        bearer("jeton-valide"),
      ),
    );
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ error: "too-many-ops" });
  });

  it("200 avec la PushResponse contractuelle et l'horloge serveur", async () => {
    const expected: PushResponse = {
      accepted: [],
      rejected: [{ opId: crypto.randomUUID(), reason: "unknown-table" }],
      conflicts: [],
    };

    const op = pushOp({ opId: crypto.randomUUID() });
    const apply = vi.fn(
      async (
        _ctx: DeviceTokenContext,
        _ops: ChangeOp[],
        _now: Date,
      ): Promise<PushResponse> => expected,
    );
    const handler = createSyncPushHandler({
      verifyToken: async () => CTX,
      apply,
    });

    const res = await handler(
      postJson({ deviceId: "device-1", clinicId: "c1", ops: [op] }, bearer("jeton-valide")),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    expect(apply).toHaveBeenCalledOnce();

    // Le handler passe le contexte du jeton + les ops validées + une horloge serveur.
    const [ctxArg, opsArg, nowArg] = apply.mock.calls[0];
    expect(ctxArg).toEqual(CTX);
    expect(opsArg).toEqual([op]);
    expect(nowArg).toBeInstanceOf(Date);
    expect(Math.abs(nowArg.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("403 sur SyncScopeError levée par le store", async () => {
    const handler = createSyncPushHandler({
      verifyToken: async () => CTX,
      apply: async () => {
        throw new SyncScopeError();
      },
    });

    const res = await handler(
      postJson({ deviceId: "device-1", clinicId: "c1", ops: [pushOp()] }, bearer("jeton-valide")),
    );
    expect(res.status).toBe(403);
    expect(await errorBody(res)).toEqual({ error: "forbidden" });
  });

  it("500 générique (jamais le détail interne) sur une exception inattendue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createSyncPushHandler({
      verifyToken: async () => CTX,
      apply: async () => {
        throw new Error("détail interne ultra-confidentiel");
      },
    });

    const res = await handler(
      postJson({ deviceId: "device-1", clinicId: "c1", ops: [pushOp()] }, bearer("jeton-valide")),
    );
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: "internal-error" });
    // Le message d'erreur interne ne quitte jamais le serveur.
    expect(raw).not.toContain("confidentiel");
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/sync/pull                                                         */
/* -------------------------------------------------------------------------- */

const PULL_RESPONSE: PullResponse = {
  changes: [
    {
      opId: crypto.randomUUID(),
      table: "patient",
      rowId: "p1",
      op: "insert",
      payload: { id: "p1", clinicId: "c1", firstName: "Zoé" },
      clinicId: "c1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      rev: 1,
    },
  ],
  cursor: { updatedAt: "2026-01-01T00:00:00.000Z", id: "p1" },
  hasMore: false,
};

describe("POST /api/sync/pull", () => {
  it("401 sans en-tête Authorization", async () => {
    const pull = vi.fn();
    const handler = createSyncPullHandler({
      verifyToken: async () => CTX,
      pull,
    });

    const res = await handler(postJson({ clinicId: "c1", cursor: null }));
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ error: "unauthorized" });
    expect(pull).not.toHaveBeenCalled();
  });

  it("403 (anti-IDOR) sur un clinicId hors de la portée du jeton", async () => {
    const pull = vi.fn();
    const handler = createSyncPullHandler({
      verifyToken: async () => CTX,
      pull,
    });

    const res = await handler(
      postJson({ clinicId: "c2-etranger", cursor: null }, bearer("jeton-valide")),
    );
    expect(res.status).toBe(403);
    expect(await errorBody(res)).toEqual({ error: "clinic-out-of-scope" });
    // Le store n'est même pas appelé : le verrou est posé au niveau route.
    expect(pull).not.toHaveBeenCalled();
  });

  it("200 avec le PullResponse du store et le curseur retourné tel quel", async () => {
    const pull = vi.fn(
      async (
        _ctx: DeviceTokenContext,
        _req: PullRequest,
        _now: Date,
      ): Promise<PullResponse> => PULL_RESPONSE,
    );
    const handler = createSyncPullHandler({
      verifyToken: async () => CTX,
      pull,
    });

    const req = {
      clinicId: "c1",
      cursor: { updatedAt: "2025-12-31T23:59:59.999Z", id: "p0" },
      limit: 50,
    };
    const res = await handler(postJson(req, bearer("jeton-valide")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PULL_RESPONSE);
    expect(pull).toHaveBeenCalledOnce();

    const [ctxArg, reqArg, nowArg] = pull.mock.calls[0];
    expect(ctxArg).toEqual(CTX);
    expect(reqArg).toEqual(req);
    expect(nowArg).toBeInstanceOf(Date);
  });
});
