import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSyncMediaHandlers,
  type MediaPutInput,
  type MediaReadResult,
} from "@/app/api/sync/media/route";
import type { DeviceTokenContext } from "@/lib/sync/central-auth";
import {
  createLocalBlobStore,
  MAX_BLOB_SIZE,
  sha256,
  type BlobStore,
} from "../offline/blob-store";
import { syncMediaOnce, type MediaSyncDeps } from "./media-sync";
import type { SyncLogger } from "./runner-core";

/**
 * Tests **hermétiques** de la synchronisation des fichiers (tâche 8.1).
 *
 *  - `blob-store` : disque réel, mais toujours dans un dossier temporaire
 *    **propre** (créé puis supprimé par test) — les cas « écriture hors base »
 *    prouvent qu'aucun fichier n'apparaît à côté de la base ;
 *  - `syncMediaOnce` : deps entièrement mémoire ;
 *  - route `/api/sync/media` : fabrique `createSyncMediaHandlers` avec deps
 *    injectées (aucune base, aucun stockage, aucun réseau).
 *
 * Aucun test ne touche `next dev` (3000) ni PostgreSQL (5432).
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const CLINIC_ID = "clinic-1";
const OTHER_CLINIC_ID = "clinic-2";
const KEY = `${CLINIC_ID}/radiograph-1.png`;
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_TOKEN = "jeton-valide-abc123";

const CTX: DeviceTokenContext = {
  deviceId: "device-1",
  userId: "user-1",
  clinicIds: [CLINIC_ID],
  trustExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
};

function createLogger(): { logger: SyncLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(`info:${message}`),
      warn: (message) => lines.push(`warn:${message}`),
      error: (message) => lines.push(`error:${message}`),
    },
  };
}

/** Comparaison d'octets indépendante du constructeur (`Buffer` vs `Uint8Array`). */
function sameBytes(actual: Uint8Array | null, expected: Uint8Array): boolean {
  if (actual === null) return false;
  if (actual.byteLength !== expected.byteLength) return false;
  for (let i = 0; i < expected.byteLength; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* `blob-store`                                                                */
/* -------------------------------------------------------------------------- */

describe("createLocalBlobStore", () => {
  let baseDir: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "dental-blobs-"));
    blobs = createLocalBlobStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("écrit, lit, compte et supprime un blob (empreinte sha256)", async () => {
    expect(await blobs.has(KEY)).toBe(false);
    expect(await blobs.stat(KEY)).toBeNull();

    const put = await blobs.put(KEY, BYTES);
    expect(put.sha256).toBe(sha256(BYTES));

    expect(await blobs.has(KEY)).toBe(true);
    expect(await blobs.stat(KEY)).toEqual({ size: BYTES.byteLength });
    expect(sameBytes(await blobs.get(KEY), BYTES)).toBe(true);

    await blobs.delete(KEY);
    expect(await blobs.has(KEY)).toBe(false);
    expect(await blobs.get(KEY)).toBeNull();
    // Suppression idempotente (absente = succès).
    await blobs.delete(KEY);
  });

  it("crée les sous-dossiers de la clé", async () => {
    await blobs.put(KEY, BYTES);
    expect(await exists(join(baseDir, CLINIC_ID))).toBe(true);
    expect(await exists(join(baseDir, KEY))).toBe(true);
  });

  it("refuse une clé traversant le dossier : zéro écriture hors base", async () => {
    const escaped = resolve(dirname(baseDir), "escape.png");

    await expect(blobs.put("../escape.png", BYTES)).rejects.toThrow();
    expect(await exists(escaped)).toBe(false);

    expect(await blobs.get("../escape.png")).toBeNull();
    expect(await blobs.has("../escape.png")).toBe(false);
    expect(await blobs.stat("../escape.png")).toBeNull();
    await expect(blobs.delete("../escape.png")).rejects.toThrow();
    expect(await exists(escaped)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "refuse un chemin absolu de disque (sortie de base après resolve)",
    async () => {
      await expect(blobs.put("C:/evil.png", BYTES)).rejects.toThrow();
      expect(await exists("C:/evil.png")).toBe(false);
    },
  );

  it("borne la taille à 10 Mo", async () => {
    const tooLarge = new Uint8Array(MAX_BLOB_SIZE + 1);
    await expect(blobs.put(KEY, tooLarge)).rejects.toThrow(/10 Mo/);
    expect(await blobs.has(KEY)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* `syncMediaOnce`                                                             */
/* -------------------------------------------------------------------------- */

interface Harness {
  baseDir: string;
  blobs: BlobStore;
  logger: SyncLogger;
  lines: string[];
  calls: { download: string[]; upload: string[]; presence: string[] };
}

async function createHarness(): Promise<Harness> {
  const baseDir = await mkdtemp(join(tmpdir(), "dental-media-"));
  const { logger, lines } = createLogger();
  return {
    baseDir,
    blobs: createLocalBlobStore(baseDir),
    logger,
    lines,
    calls: { download: [], upload: [], presence: [] },
  };
}

interface DepOverrides {
  list?: () => Promise<{ fileKey: string }[]>;
  downloadRemote?: (key: string) => Promise<Uint8Array | null>;
  hasRemote?: (key: string) => Promise<boolean>;
  uploadLocal?: (key: string, bytes: Uint8Array) => Promise<boolean>;
}

function createDeps(harness: Harness, overrides: DepOverrides = {}): MediaSyncDeps {
  return {
    blobs: harness.blobs,
    listLocalRadiographs:
      overrides.list ?? (async () => [{ fileKey: KEY }]),
    downloadRemote:
      overrides.downloadRemote ??
      (async (key) => {
        harness.calls.download.push(key);
        return BYTES;
      }),
    hasRemote:
      overrides.hasRemote ??
      (async (key) => {
        harness.calls.presence.push(key);
        return false;
      }),
    uploadLocal:
      overrides.uploadLocal ??
      (async (key, bytes) => {
        harness.calls.upload.push(key);
        expect(sameBytes(bytes, BYTES)).toBe(true);
        return true;
      }),
    logger: harness.logger,
  };
}

describe("syncMediaOnce", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await rm(harness.baseDir, { recursive: true, force: true });
  });

  it("télécharge une clé absente du magasin", async () => {
    const deps = createDeps(harness);

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary).toEqual({ downloaded: 1, uploaded: 0, skipped: 0, errors: 0 });
    expect(harness.calls.download).toEqual([KEY]);
    expect(sameBytes(await harness.blobs.get(KEY), BYTES)).toBe(true);
  });

  it("téléverse un fichier local absent du central", async () => {
    await harness.blobs.put(KEY, BYTES);
    const deps = createDeps(harness, {
      downloadRemote: async () => {
        throw new Error("ne doit pas être appelé (fichier déjà local)");
      },
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary).toEqual({ downloaded: 0, uploaded: 1, skipped: 0, errors: 0 });
    expect(harness.calls.presence).toEqual([KEY]);
    expect(harness.calls.upload).toEqual([KEY]);
  });

  it("compte `skipped` lorsque le central refuse (413/415/403 → false)", async () => {
    await harness.blobs.put(KEY, BYTES);
    const deps = createDeps(harness, {
      downloadRemote: async () => {
        throw new Error("ne doit pas être appelé");
      },
      uploadLocal: async () => false,
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary).toEqual({ downloaded: 0, uploaded: 0, skipped: 1, errors: 0 });
    // Un refus n'est JAMAIS une erreur fatale.
    expect(harness.lines.some((line) => line.startsWith("error:"))).toBe(false);
  });

  it("n'écrit ni ne contacte le central pour une clé dangereuse", async () => {
    const dangerous = ["../../evil.png", "..\\evil.png", ""];
    const deps = createDeps(harness, {
      list: async () => dangerous.map((fileKey) => ({ fileKey })),
      downloadRemote: async () => BYTES,
      uploadLocal: async () => true,
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary).toEqual({ downloaded: 0, uploaded: 0, skipped: 3, errors: 0 });
    expect(harness.calls.download).toEqual([]);
    expect(harness.calls.upload).toEqual([]);
    // Rien n'a été écrit, ni dans la base ni à côté.
    expect(await readdir(harness.baseDir)).toEqual([]);
    expect(await exists(resolve(dirname(harness.baseDir), "evil.png"))).toBe(false);
  });

  it("respecte le plafond `maxItems` (budget partagé, téléchargements d'abord)", async () => {
    const keys = [1, 2, 3, 4, 5].map((n) => `${CLINIC_ID}/radiograph-${n}.png`);
    const deps = createDeps(harness, {
      list: async () => keys.map((fileKey) => ({ fileKey })),
      downloadRemote: async (key) => {
        harness.calls.download.push(key);
        return BYTES;
      },
    });

    const summary = await syncMediaOnce(deps, { maxItems: 2 });

    expect(summary.downloaded).toBe(2);
    expect(harness.calls.download).toEqual(keys.slice(0, 2));
    expect(await readdir(join(harness.baseDir, CLINIC_ID))).toHaveLength(2);
  });

  it("isole une erreur réseau : les autres items continuent, aucune levée", async () => {
    const first = `${CLINIC_ID}/radiograph-1.png`;
    const second = `${CLINIC_ID}/radiograph-2.png`;
    const deps = createDeps(harness, {
      list: async () => [{ fileKey: first }, { fileKey: second }],
      downloadRemote: async (key) => {
        harness.calls.download.push(key);
        if (key === first) throw new Error("réseau indisponible");
        return BYTES;
      },
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary).toEqual({ downloaded: 1, uploaded: 0, skipped: 0, errors: 1 });
    expect(await harness.blobs.has(second)).toBe(true);
    expect(await harness.blobs.has(first)).toBe(false);
    // Motif journalisé sans secret.
    expect(harness.lines.join("\n")).toContain("réseau indisponible");
  });

  it("borne le temps d'attente d'un appel distant (timeout par item)", async () => {
    const deps = createDeps(harness, {
      downloadRemote: () => new Promise<Uint8Array | null>(() => undefined),
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20, timeoutMs: 5 });

    expect(summary).toEqual({ downloaded: 0, uploaded: 0, skipped: 0, errors: 1 });
    expect(await harness.blobs.has(KEY)).toBe(false);
  });

  it("renvoie des compteurs nuls pour `maxItems: 0` sans rien tenter", async () => {
    const deps = createDeps(harness);

    const summary = await syncMediaOnce(deps, { maxItems: 0 });

    expect(summary).toEqual({ downloaded: 0, uploaded: 0, skipped: 0, errors: 0 });
    expect(harness.calls.download).toEqual([]);
    expect(harness.calls.presence).toEqual([]);
  });

  it("ne jamais rejeter, même si l'inventaire local échoue", async () => {
    const deps = createDeps(harness, {
      list: async () => {
        throw new Error("base locale indisponible");
      },
    });

    const summary = await syncMediaOnce(deps, { maxItems: 20 });

    expect(summary.errors).toBe(1);
    expect(summary.downloaded).toBe(0);
    expect(harness.lines.join("\n")).toContain("inventaire local impossible");
  });
});

/* -------------------------------------------------------------------------- */
/* Route `/api/sync/media`                                                     */
/* -------------------------------------------------------------------------- */

describe("route /api/sync/media", () => {
  const stored = new Map<string, Uint8Array>();

  type SyncMediaVerify = (token: string, now: Date) => Promise<DeviceTokenContext | null>;

  function createHandlers(
    overrides: Partial<{
      verifyToken: SyncMediaVerify;
      put: (input: MediaPutInput) => Promise<string>;
      read: (key: string) => Promise<MediaReadResult>;
    }> = {},
  ) {
    return createSyncMediaHandlers({
      verifyToken:
        overrides.verifyToken ?? (async (token) => (token === VALID_TOKEN ? CTX : null)),
      put:
        overrides.put ??
        (async (input) => `${input.key}${extname(input.name)}`),
      read:
        overrides.read ??
        (async (key) => {
          const bytes = stored.get(key);
          return bytes === undefined ? { kind: "missing" as const } : { kind: "ok" as const, bytes };
        }),
      ...overrides,
    });
  }

  function bearer(token = VALID_TOKEN): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function postJson(body: unknown, token: string | null = VALID_TOKEN): Request {
    return new Request("http://localhost/api/sync/media", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : bearer(token)),
      },
      body: JSON.stringify(body),
    });
  }

  function getRequest(key: string, clinicId: string, token: string | null = VALID_TOKEN): Request {
    const query = `key=${encodeURIComponent(key)}&clinicId=${encodeURIComponent(clinicId)}`;
    return new Request(`http://localhost/api/sync/media?${query}`, {
      method: "GET",
      headers: token === null ? {} : bearer(token),
    });
  }

  async function errorOf(response: Response): Promise<{ error: string }> {
    return (await response.json()) as { error: string };
  }

  beforeEach(() => {
    stored.clear();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST sans jeton → 401 (avant toute lecture du corps)", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(postJson({ key: KEY }, null));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({ error: "unauthorized" });
  });

  it("POST avec un jeton inconnu → 401", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(postJson({ key: KEY }, "jeton-invalide"));
    expect(response.status).toBe(401);
  });

  it("POST avec une clé traversante → 400 invalid-key", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(
      postJson({ key: "../../evil.png", clinicId: CLINIC_ID, contentBase64: "AAAA" }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({ error: "invalid-key" });
  });

  it("POST avec un cabinet hors portée du jeton → 403", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(
      postJson({ key: KEY, clinicId: OTHER_CLINIC_ID, contentBase64: "AAAA" }),
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({ error: "clinic-out-of-scope" });
  });

  it("POST au-delà de 10 Mo → 413 (arrêt avant décodage)", async () => {
    const handlers = createHandlers();
    const oversized = "A".repeat(14_000_000);
    const response = await handlers.POST(
      postJson({ key: KEY, clinicId: CLINIC_ID, contentBase64: oversized }),
    );
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toEqual({ error: "payload-too-large" });
  });

  it("POST avec un contenu base64 malformé → 400", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(
      postJson({ key: KEY, clinicId: CLINIC_ID, contentBase64: "!!pas-du-base64!!" }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({ error: "invalid-request" });
  });

  it("POST avec une extension hors allow-list → 415", async () => {
    const handlers = createHandlers();
    const response = await handlers.POST(
      postJson({
        key: `${CLINIC_ID}/radiograph-1.txt`,
        clinicId: CLINIC_ID,
        contentBase64: "AAAA",
      }),
    );
    expect(response.status).toBe(415);
    expect(await errorOf(response)).toEqual({ error: "unsupported-media-type" });
  });

  it("POST valide → 200 { key, sha256 } et stockage via l'adaptateur", async () => {
    const inputs: MediaPutInput[] = [];
    const handlers = createHandlers({
      put: async (input) => {
        inputs.push(input);
        return `${input.key}${extname(input.name)}`;
      },
    });
    const contentBase64 = Buffer.from(BYTES).toString("base64");

    const response = await handlers.POST(
      postJson({ key: KEY, clinicId: CLINIC_ID, contentBase64 }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: KEY, sha256: sha256(BYTES) });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].key).toBe(`${CLINIC_ID}/radiograph-1`);
    expect(inputs[0].name).toBe("radiograph-1.png");
    expect(inputs[0].type).toBe("image/png");
    expect(sameBytes(inputs[0].bytes, BYTES)).toBe(true);

    // Événement journalisé sans secret : ni jeton, ni contenu.
    const logged = JSON.stringify([
      ...(vi.mocked(console.info).mock.calls as unknown[][]),
      ...(vi.mocked(console.error).mock.calls as unknown[][]),
    ]);
    expect(logged).not.toContain(VALID_TOKEN);
    expect(logged).not.toContain(contentBase64);
  });

  it("GET sans jeton → 401 (et non 307/500)", async () => {
    const handlers = createHandlers();
    const response = await handlers.GET(getRequest(KEY, CLINIC_ID, null));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({ error: "unauthorized" });
  });

  it("GET valide → 200 avec Content-Type, Content-Length et no-store", async () => {
    stored.set(KEY, BYTES);
    const handlers = createHandlers();
    const response = await handlers.GET(getRequest(KEY, CLINIC_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(BYTES.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(sameBytes(new Uint8Array(await response.arrayBuffer()), BYTES)).toBe(true);
  });

  it("GET d'un fichier absent → 404", async () => {
    const handlers = createHandlers();
    const response = await handlers.GET(getRequest(KEY, CLINIC_ID));
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({ error: "not-found" });
  });

  it("GET hors portée du cabinet → 403", async () => {
    const handlers = createHandlers();
    const response = await handlers.GET(getRequest(KEY, OTHER_CLINIC_ID));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({ error: "clinic-out-of-scope" });
  });

  it("GET avec une clé traversante → 400 invalid-key", async () => {
    const handlers = createHandlers();
    const response = await handlers.GET(getRequest("../../evil.png", CLINIC_ID));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({ error: "invalid-key" });
  });
});
