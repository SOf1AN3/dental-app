"use server";

import { db } from "@/lib/db/db";
import { treatmentCatalog } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAction } from "@/lib/audit";

export async function getTreatmentCatalog() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db.query.treatmentCatalog.findMany({
      where: eq(treatmentCatalog.clinicId, clinicId),
      orderBy: (tc, { asc }) => [asc(tc.name)],
    });
  } catch {
    return [];
  }
}

const catalogItemSchema = z.object({
  name: z.string().min(1, "Nom du traitement requis"),
  code: z.string().optional().or(z.literal("")),
  category: z.string().optional().or(z.literal("")),
  price: z.coerce.number().min(0, "Le prix doit être supérieur ou égal à 0"),
  description: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().optional().default(true),
});

export async function createTreatmentCatalogItem(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = catalogItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [created] = await db.insert(treatmentCatalog).values({
      clinicId,
      name: data.name,
      code: data.code || null,
      category: data.category || null,
      price: data.price,
      description: data.description || null,
      isActive: data.isActive,
    }).returning({ id: treatmentCatalog.id });

    if (created) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "treatment_catalog_item",
        entityId: created.id,
        after: {
          name: data.name,
          code: data.code || null,
          category: data.category || null,
          price: data.price,
          isActive: data.isActive,
        },
      });
    }

    revalidatePath("/settings/treatment-catalog");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la création du traitement"] } };
  }
}

export async function updateTreatmentCatalogItem(
  id: string,
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Verify the item belongs to this clinic
  const existing = await db.query.treatmentCatalog.findFirst({
    where: and(eq(treatmentCatalog.id, id), eq(treatmentCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: { general: ["Traitement introuvable"] } };
  }

  const validated = catalogItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    await db
      .update(treatmentCatalog)
      .set({
        name: data.name,
        code: data.code || null,
        category: data.category || null,
        price: data.price,
        description: data.description || null,
        isActive: data.isActive,
      })
      .where(eq(treatmentCatalog.id, id));

    await logAction({
      clinicId,
      action: "update",
      entityType: "treatment_catalog_item",
      entityId: id,
      before: {
        name: existing.name,
        code: existing.code ?? null,
        category: existing.category ?? null,
        price: existing.price,
        isActive: existing.isActive,
      },
      after: {
        name: data.name,
        code: data.code || null,
        category: data.category || null,
        price: data.price,
        isActive: data.isActive,
      },
    });

    revalidatePath("/settings/treatment-catalog");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour du traitement"] } };
  }
}

export async function deleteTreatmentCatalogItem(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Verify the item belongs to this clinic
  const existing = await db.query.treatmentCatalog.findFirst({
    where: and(eq(treatmentCatalog.id, id), eq(treatmentCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: "Traitement introuvable" };
  }

  try {
    await db
      .delete(treatmentCatalog)
      .where(eq(treatmentCatalog.id, id));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "treatment_catalog_item",
      entityId: id,
      before: {
        name: existing.name,
        code: existing.code ?? null,
        price: existing.price,
      },
    });

    revalidatePath("/settings/treatment-catalog");
    return { success: true };
  } catch {
    return { success: false, error: "Erreur lors de la suppression du traitement" };
  }
}

export async function toggleTreatmentCatalogItemActive(id: string, isActive: boolean) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Verify the item belongs to this clinic
  const existing = await db.query.treatmentCatalog.findFirst({
    where: and(eq(treatmentCatalog.id, id), eq(treatmentCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: "Traitement introuvable" };
  }

  try {
    await db
      .update(treatmentCatalog)
      .set({ isActive })
      .where(eq(treatmentCatalog.id, id));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "treatment_catalog_item",
      entityId: id,
      before: { isActive: existing.isActive },
      after: { isActive },
    });

    revalidatePath("/settings/treatment-catalog");
    return { success: true };
  } catch {
    return { success: false, error: "Erreur lors de la mise à jour du statut" };
  }
}
