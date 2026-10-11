"use server";

import { db } from "@/lib/db/db";
import { odontogramStates } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, sql } from "drizzle-orm";
import { logAction } from "@/lib/audit";
import { z } from "zod";

/**
 * Z-41 — limites du payload odontogramme (`jsonb`).
 *
 * `state` est stocké tel quel dans un `jsonb` : sans contrôle, un tableau, un
 * objet vide ou un arbre de profondeur/taille arbitraire serait persisté.
 * Les bornes ci-dessous calquent la forme RÉELLEMENT produite par
 * `exportStatusPayload()` (`{ version, globals?, teeth }`) et la numérotation
 * FDI réellement utilisée par l'application (ALL_TEETH du composant
 * odontogramme : 11–18 / 21–28 / 31–38 / 41–48, plus la dentition temporaire
 * FDI 51–55 / 61–65 / 71–75 / 81–85 si elle était ajoutée un jour).
 */
const ODONTOGRAM_MAX_TEETH = 32;
const ODONTOGRAM_MAX_DEPTH = 6;
/** Taille max du payload serialisé en octets (UTF-8). */
const ODONTOGRAM_MAX_PAYLOAD_BYTES = 512 * 1024;

/**
 * Vérifie qu'un entier est un numéro de dent ISO 3950 / FDI valide :
 * quadrant 1–4 (permanent, positions 1–8) ou quadrant 5–8 (temporaire,
 * positions 1–5). `11…18`, `21…28`, `31…38`, `41…48` passent ; `-1`, `0`,
 * `999`, `10`, `19` échouent.
 */
function isValidFdiToothNumber(value: number): boolean {
  const quadrant = Math.floor(value / 10);
  const position = value % 10;
  if (quadrant >= 1 && quadrant <= 4) return position >= 1 && position <= 8;
  if (quadrant >= 5 && quadrant <= 8) return position >= 1 && position <= 5;
  return false;
}

function isValidFdiToothKey(key: string): boolean {
  if (!/^\d{2}$/.test(key)) return false;
  return isValidFdiToothNumber(Number(key));
}

/** Profondeur d'un arbre JSON (feuilles = profondeur 0). Bornée côté boucle. */
function jsonDepth(value: unknown, depth: number): number {
  if (depth >= ODONTOGRAM_MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) {
      const nested = jsonDepth(item, depth + 1);
      if (nested > max) max = nested;
      if (max >= ODONTOGRAM_MAX_DEPTH) return max;
    }
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = depth;
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const childDepth = jsonDepth(nested, depth + 1);
      if (childDepth > max) max = childDepth;
      if (max >= ODONTOGRAM_MAX_DEPTH) return max;
    }
    return max;
  }
  return depth;
}

const odontogramStateSchema = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  globals: z.record(z.string(), z.unknown()).optional(),
  teeth: z
    .record(z.string(), z.unknown())
    .refine(
      (teeth) => Object.keys(teeth).length <= ODONTOGRAM_MAX_TEETH,
      `Trop de dents dans le payload (max ${ODONTOGRAM_MAX_TEETH})`,
    )
    .refine(
      (teeth) => Object.keys(teeth).every(isValidFdiToothKey),
      "Clé de dent invalide : numérotation FDI attendue (11–48)",
    )
    .refine(
      (teeth) =>
        Object.values(teeth).every(
          (record) =>
            record !== null &&
            typeof record === "object" &&
            !Array.isArray(record),
        ),
      "Enregistrement de dent invalide",
    ),
});

/**
 * Valide intégralement le payload avant toute écriture `jsonb`.
 * @returns `null` si le payload est acceptable, sinon le message d'erreur.
 */
function validateOdontogramState(state: unknown): string | null {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return "Données odontogramme invalides";
  }

  const parsed = odontogramStateSchema.safeParse(state);
  if (!parsed.success) {
    return (
      parsed.error.issues[0]?.message ?? "Données odontogramme invalides"
    );
  }

  if (jsonDepth(state, 0) > ODONTOGRAM_MAX_DEPTH) {
    return "Structure odontogramme trop profonde";
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return "Données odontogramme non sérialisables";
  }

  // Taille en octets UTF-8 (TextEncoder plutôt que `Buffer` : disponible aussi
  // si le module était exécuté hors runtime Node).
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > ODONTOGRAM_MAX_PAYLOAD_BYTES) {
    return "Payload odontogramme trop volumineux";
  }

  return null;
}

export async function getOdontogramState(
  patientId: string,
): Promise<{ state: unknown; version: number } | null> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const row = await db.query.odontogramStates.findFirst({
      where: and(
        eq(odontogramStates.patientId, patientId),
        eq(odontogramStates.clinicId, clinicId),
      ),
    });
    if (!row) return null;
    return { state: row.state, version: row.version };
  } catch {
    return null;
  }
}

export async function saveOdontogramState(
  patientId: string,
  state: unknown,
  expectedVersion: number,
): Promise<
  | { ok: true; version: number }
  | { ok: false; error: string }
  | { ok: false; code: "CONFLICT"; currentVersion: number; error: string }
> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Z-41 : `expectedVersion` est un nombre côté TS mais provient du client.
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return { ok: false, error: "Version attendue invalide" };
  }

  // Z-41 : forme, clés FDI, profondeur et taille du payload bornées avant
  // toute écriture `jsonb` (un tableau, `{}` ou `{ teeth: { 999: … } }` échouent).
  const validationError = validateOdontogramState(state);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    const existing = await db.query.odontogramStates.findFirst({
      where: and(
        eq(odontogramStates.patientId, patientId),
        eq(odontogramStates.clinicId, clinicId),
      ),
      columns: { id: true, version: true },
    });

    if (!existing) {
      // Z-41 : la version initiale n'est plus imposée à 1 quel que soit le
      // `expectedVersion` du client. Un client qui pense être en version N > 0
      // alors que la ligne n'existe pas (ligne supprimée, onglet périmé) reçoit
      // un CONFLICT cohérent au lieu d'un `ok: true` avec une version recréée.
      if (expectedVersion !== 0) {
        return {
          ok: false,
          code: "CONFLICT",
          error: "Modifié dans une autre session. Rechargez la page.",
          currentVersion: 0,
        };
      }

      await db
        .insert(odontogramStates)
        .values({ clinicId, patientId, state, version: 1 });

      await logAction({
        clinicId,
        action: "create",
        entityType: "odontogram_state",
        entityId: patientId,
        after: { version: 1 },
      });

      return { ok: true, version: 1 };
    }

    if (existing.version !== expectedVersion) {
      return {
        ok: false,
        code: "CONFLICT",
        error: "Modifié dans une autre session. Rechargez la page.",
        currentVersion: existing.version,
      };
    }

    const updated = await db
      .update(odontogramStates)
      .set({
        state,
        version: sql`version + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(odontogramStates.id, existing.id),
          eq(odontogramStates.version, expectedVersion),
        ),
      )
      .returning({ version: odontogramStates.version });

    const newVersion = updated[0]?.version;
    if (newVersion == null) {
      const fresh = await db.query.odontogramStates.findFirst({
        where: and(
          eq(odontogramStates.patientId, patientId),
          eq(odontogramStates.clinicId, clinicId),
        ),
        columns: { version: true },
      });
      return {
        ok: false,
        code: "CONFLICT",
        error: "Modifié dans une autre session. Rechargez la page.",
        currentVersion: fresh?.version ?? existing.version,
      };
    }

    await logAction({
      clinicId,
      action: "update",
      entityType: "odontogram_state",
      entityId: patientId,
      before: { version: expectedVersion },
      after: { version: newVersion },
    });

    return { ok: true, version: newVersion };
  } catch {
    return { ok: false, error: "Erreur lors de la sauvegarde de l'odontogramme" };
  }
}
