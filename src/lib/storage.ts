import { writeFile, mkdir, unlink, access } from "fs/promises";
import { join, dirname, extname } from "path";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

export async function resolveStoredUrl(
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  if (!isStoredKey(value)) return value;
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
