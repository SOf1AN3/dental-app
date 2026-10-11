import { readFile } from "fs/promises";
import { extname, resolve, sep } from "path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import { isStoredKey, LOCAL_UPLOADS_BASE_PATH } from "@/lib/storage";

/**
 * GET /api/files/[...key]
 *
 * Sert un fichier de l'adaptateur de stockage local APRÈS vérification :
 *  1. session utilisateur + clinique courante (`requireCurrentClinic` lit ET
 *     valide le cookie `active_clinic_id` contre la table des appartenances) ;
 *  2. format de la clé (jeu de caractères fermé — aucun `..`, aucun séparateur,
 *     aucun caractère Windows normalisable) : anti path traversal ;
 *  3. contenu du répertoire d'uploads (contrôle de préfixe après `resolve`) ;
 *  4. appartenance de la clé à la clinique courante.
 *
 * Remplace le service statique `/uploads/<key>` qui ne passait par aucun
 * contrôle d'accès.
 */

/**
 * Clés émises par le serveur : `clinics/<clinicId>/logo.png` et
 * `<clinicId>/radiograph-<uuid>.pdf` → identifiants UUID + noms fixes.
 * Le premier caractère doit être alphanumérique (exclut `.`, `..`, `C:…`).
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

const fileKeySchema = z
  .array(z.string().regex(KEY_SEGMENT_PATTERN))
  .min(2)
  .max(32);

/** Types autorisés à la lecture (mêmes familles que l'upload). */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/**
 * La clé doit être scopée à la clinique courante, sous l'un des deux formats
 * réellement générés par le code d'upload.
 */
function isKeyOwnedByClinic(
  segments: readonly string[],
  clinicId: string,
): boolean {
  const [first, second] = segments;
  if (first === "clinics") {
    // `clinics/<clinicId>/logo.png`
    return segments.length >= 3 && second === clinicId;
  }
  // `<clinicId>/radiograph-<uuid>.pdf`
  return segments.length >= 2 && first === clinicId;
}

/** Distingue les redirections Next (`/login`, `/select-clinic`) des vraies erreurs. */
function isNextRedirect(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return false;
  }
  return (
    typeof error.digest === "string" && error.digest.startsWith("NEXT_REDIRECT")
  );
}

function jsonError(message: string, status: number): Response {
  return NextResponse.json({ error: message }, { status });
}

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key: segments } = await params;

  // 1. Authentification + clinique courante (cookie validé en base).
  let clinicId: string;
  try {
    clinicId = await requireCurrentClinic();
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    // Échec de l'appartenance à la clinique ou erreur imprévue : refus ferme.
    console.error("[api/files] échec de vérification de l'accès à la clinique", error);
    return jsonError("Accès refusé", 403);
  }

  // 2. Format de la clé (anti path traversal).
  const parsed = fileKeySchema.safeParse(segments);
  if (!parsed.success) {
    return jsonError("Clé de fichier invalide", 400);
  }
  const key = parsed.data.join("/");
  if (!isStoredKey(key)) {
    return jsonError("Clé de fichier invalide", 400);
  }

  // 3. Le chemin résolu doit rester à l'intérieur du répertoire d'uploads.
  const uploadsRoot = resolve(process.cwd(), LOCAL_UPLOADS_BASE_PATH);
  const filePath = resolve(uploadsRoot, ...parsed.data);
  if (filePath === uploadsRoot || !filePath.startsWith(uploadsRoot + sep)) {
    console.error("[api/files] tentative de sortie du répertoire d'uploads refusée", {
      key,
    });
    return jsonError("Accès refusé", 403);
  }

  // 4. La clé appartient-elle à la clinique courante ?
  if (!isKeyOwnedByClinic(parsed.data, clinicId)) {
    return jsonError("Accès refusé à cette clinique", 403);
  }

  // 5. Lecture du fichier.
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return jsonError("Fichier introuvable", 404);
    }
    console.error("[api/files] lecture du fichier impossible", { key, code });
    return jsonError("Erreur interne", 500);
  }

  const fileName = parsed.data[parsed.data.length - 1];
  const contentType =
    CONTENT_TYPE_BY_EXTENSION[extname(fileName).toLowerCase()] ??
    "application/octet-stream";

  return new NextResponse(new Uint8Array(content), {
    headers: {
      "Content-Type": contentType,
      // `fileName` est validé par KEY_SEGMENT_PATTERN : pas de `"` ni de contrôle.
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
