import { writeFile, mkdir, unlink, access } from "fs/promises";
import { join, dirname, extname } from "path";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Z-79 — longueur maximale d'une clé de stockage (segments confondus). */
const MAX_KEY_LENGTH = 512;

export interface StorageAdapter {
  upload(file: File, key: string): Promise<string>;
  getSignedUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export function isStoredKey(value: string): boolean {
  return (
    !value.startsWith("/uploads/") &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
  );
}

/**
 * Z-79 — format admis pour une clé de stockage (anti path traversal).
 *
 * Les clés sont aujourd'hui générées côté serveur (`clinics/<uuid>/logo`,
 * `<uuid>/radiograph-<uuid>`), mais elles sont CONCATÉNÉES à `basePath` dans
 * `join(process.cwd(), basePath, key)` — un `..` dans une clé ferait sortir
 * du dossier `uploads/` (écriture, lecture ou suppression hors base). C'est
 * d'autant plus utile que `upload()` reçoit parfois un `clinicId` issu d'un
 * cookie forgeable (`clinics/${clinicId}/logo` dans `settings.ts`).
 *
 * On VALIDE le format plutôt que de réduire la clé à son `basename()` : les
 * clés existantes CONTIENNENT des `/` (sous-répertoires) — `basename()`
 * casserait la lecture de TOUTES les clés déjà stockées en base.
 *
 * Refusé : chaîne vide, trop longue, NUL (troncature C), `\` (séparateur
 * Windows), chemin absolu, et tout segment vide, `.` ou `..`.
 */
export function isSafeStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  if (key.startsWith("/")) return false;
  return key
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

/**
 * Z-79 — allowlist des hôtes acceptés pour une URL ABSOLUE stockée en base.
 *
 * Sont acceptés : l'hôte de l'endpoint S3 effectivement configuré (MinIO, R2,
 * …), l'hôte de l'application elle-même, les endpoints AWS S3 (style virtuel
 * `<bucket>.s3.amazonaws.com` et régionaux `<bucket>.s3.<région>.amazonaws.com`)
 * et, en extension optionnelle, les hôtes listés dans
 * `STORAGE_ALLOWED_HOSTS` (séparés par des virgules).
 */
function allowedAbsoluteUrlHosts(): Set<string> {
  const hosts = new Set<string>();

  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint) {
    try {
      hosts.add(new URL(endpoint).hostname.toLowerCase());
    } catch {
      // Endpoint illisible : simplement ignoré, l'allowlist reste fail-closed.
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).hostname.toLowerCase());
    } catch {
      // Idem.
    }
  }

  const extra = process.env.STORAGE_ALLOWED_HOSTS;
  if (extra) {
    for (const raw of extra.split(",")) {
      const host = raw.trim().toLowerCase();
      if (host) hosts.add(host);
    }
  }

  return hosts;
}

/**
 * Z-79 — une valeur `http(s)://` n'est renvoyée QUE si son domaine est
 * connu : une colonne URL alimentée par un client ne doit pas pouvoir
 * rediriger un utilisateur vers un domaine arbitraire (open redirect stocké).
 */
function isAllowedAbsoluteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (allowedAbsoluteUrlHosts().has(host)) return true;
  if (host === "s3.amazonaws.com") return true;
  if (host.endsWith(".s3.amazonaws.com")) return true;
  return /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
}

export async function resolveStoredUrl(
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  if (!isStoredKey(value)) {
    // URL absolue → allowlist de domaines. Les chemins relatifs historiques
    // (`/uploads/…`) sont conservés tels quels : ils ne quittent jamais
    // l'origine de l'application et sont déjà filtrés par la route `/api/files`.
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return isAllowedAbsoluteUrl(value) ? value : null;
    }
    return value;
  }
  // Clé de stockage → format contrôlé AVANT d'être joinée au disque / signée.
  if (!isSafeStorageKey(value)) return null;
  try {
    return await storage.getSignedUrl(value);
  } catch {
    return null;
  }
}

/**
 * Racine du stockage local, partagée avec la route protégée
 * `src/app/api/files/[...key]/route.ts` (qui doit lire exactement les mêmes
 * fichiers que ceux renvoyés par `LocalStorageAdapter.getSignedUrl`).
 *
 * Chemin à la racine du projet, volontairement HORS de `public/` : Next.js sert
 * `public/` statiquement et sans session, ce qui rend toute règle de routage
 * contournable (ex. `/uploads%2F<key>`). Ces fichiers étant des données de
 * santé, ils ne peuvent être lus que via `/api/files` (session + clinique +
 * anti path traversal).
 */
export const LOCAL_UPLOADS_BASE_PATH = "uploads";

export class LocalStorageAdapter implements StorageAdapter {
  private basePath: string;

  constructor(basePath: string = LOCAL_UPLOADS_BASE_PATH) {
    this.basePath = basePath;
  }

  async upload(file: File, key: string): Promise<string> {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      throw new Error(`Type de fichier non autorisé: ${file.type}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error("Le fichier dépasse la taille maximale de 10 Mo");
    }

    // Z-79 — la clé est concaténée puis joinée au disque : format contrôlé
    // avant toute écriture (pas de `..`, pas de chemin absolu).
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }

    const ext = extname(file.name) || ".bin";
    const fileName = `${key}${ext}`;
    const dirPath = join(process.cwd(), this.basePath);
    const filePath = join(dirPath, fileName);

    await mkdir(dirname(filePath), { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    return fileName;
  }

  async getSignedUrl(key: string): Promise<string> {
    // Z-79 — même contrôle que `upload` : la clé provient de la base et est
    // joinée au disque ici.
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }
    const filePath = join(process.cwd(), this.basePath, key);
    try {
      await access(filePath);
    } catch {
      throw new Error("Fichier introuvable");
    }
    // Route protégée (session + clinique + anti path traversal) au lieu du
    // chemin statique `/uploads/<key>` servi depuis `public/` sans contrôle.
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `/api/files/${encodedKey}`;
  }

  async delete(key: string): Promise<void> {
    // Z-79 — une clé invalide ne doit surtout pas atteindre `unlink` (elle
    // désignerait un fichier HORS du dossier `uploads/`).
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }
    const filePath = join(process.cwd(), this.basePath, key);
    try {
      await unlink(filePath);
    } catch {
      // File might not exist, ignore
    }
  }
}

interface S3Config {
  region: string;
  bucket: string;
  endpoint?: string;
}

function getS3Config(): S3Config | null {
  const region = process.env.S3_REGION;
  const bucket = process.env.S3_BUCKET;
  if (!region || !bucket) return null;
  return { region, bucket, endpoint: process.env.S3_ENDPOINT };
}

export class S3StorageAdapter implements StorageAdapter {
  private config: S3Config;

  constructor(config?: S3Config) {
    const cfg = config ?? getS3Config();
    if (!cfg) {
      throw new Error(
        "S3 non configuré. Définissez S3_REGION et S3_BUCKET dans .env"
      );
    }
    this.config = cfg;
  }

  async upload(file: File, key: string): Promise<string> {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      throw new Error(`Type de fichier non autorisé: ${file.type}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error("Le fichier dépasse la taille maximale de 10 Mo");
    }

    // Z-79 — même format de clé que l'adaptateur local : les clés sont
    // partagées entre les deux backends, la validation doit être identique.
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }

    const ext = extname(file.name) || ".bin";
    const fileName = `${key}${ext}`;

    const { S3Client, PutObjectCommand } = await import(
      "@aws-sdk/client-s3"
    );

    const client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint || undefined,
      forcePathStyle: Boolean(this.config.endpoint),
    });

    const buffer = Buffer.from(await file.arrayBuffer());

    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: fileName,
        Body: buffer,
        ContentType: file.type,
      })
    );

    return fileName;
  }

  async getSignedUrl(key: string): Promise<string> {
    // Z-79 — format de clé contrôlé avant signature.
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }
    const { SignatureV4 } = await import("@smithy/signature-v4");
    const { HttpRequest, buildQueryString } = await import(
      "@smithy/core/protocols"
    );
    const { Sha256 } = await import("@smithy/core/checksum");
    const { defaultProvider } = await import(
      "@aws-sdk/credential-provider-node"
    );

    const credentials = await defaultProvider()();

    const encodedKey = key.split("/").map(encodeURIComponent).join("/");

    let protocol: string;
    let hostname: string;
    let port: number | undefined;
    let path: string;

    if (this.config.endpoint) {
      const endpoint = new URL(this.config.endpoint);
      protocol = endpoint.protocol;
      hostname = endpoint.hostname;
      port = endpoint.port ? Number(endpoint.port) : undefined;
      path = `/${this.config.bucket}/${encodedKey}`;
    } else {
      protocol = "https:";
      hostname = `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
      path = `/${encodedKey}`;
    }

    const request = new HttpRequest({
      method: "GET",
      protocol,
      hostname,
      port,
      path,
      headers: { host: hostname + (port ? `:${port}` : "") },
      query: {},
    });

    const signer = new SignatureV4({
      credentials,
      region: this.config.region,
      service: "s3",
      sha256: Sha256,
      uriEscapePath: false,
      applyChecksum: false,
    });

    const signed = await signer.presign(request, { expiresIn: 300 });

    const query = buildQueryString(signed.query ?? {});
    return `${signed.protocol}//${signed.hostname}${
      signed.port ? `:${signed.port}` : ""
    }${signed.path}${query ? `?${query}` : ""}`;
  }

  async delete(key: string): Promise<void> {
    // Z-79 — format de clé contrôlé avant suppression (cohérent avec `upload`).
    if (!isSafeStorageKey(key)) {
      throw new Error("Clé de stockage invalide");
    }
    const { S3Client, DeleteObjectCommand } = await import(
      "@aws-sdk/client-s3"
    );

    const client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint || undefined,
      forcePathStyle: Boolean(this.config.endpoint),
    });

    await client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );
  }
}

export const storage: StorageAdapter =
  process.env.S3_REGION && process.env.S3_BUCKET
    ? new S3StorageAdapter()
    : new LocalStorageAdapter();
