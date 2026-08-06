"use server";

import { db } from "@/lib/db/db";
import { odontogramStates } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, sql } from "drizzle-orm";
import { logAction } from "@/lib/audit";

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

  if (!state || typeof state !== "object") {
    return { ok: false, error: "Données odontogramme invalides" };
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
