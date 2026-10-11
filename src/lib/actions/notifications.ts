"use server";

import { db } from "@/lib/db/db";
import { notifications, clinics } from "@/lib/db/schema";
import { requireAuth, requireClinicAccessOrThrow, requirePlatformOwner } from "@/lib/auth-utils";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAction } from "@/lib/audit";

const notificationSchema = z.object({
  target: z.string().min(1, "Cible requise"),
  category: z.enum(["broadcast", "maintenance", "system"], { message: "Catégorie invalide" }),
  title: z.string().min(1, "Titre requis"),
  message: z.string().min(1, "Message requis"),
  link: z
    .string()
    .optional()
    .refine((value) => !value || value.startsWith("/"), "Le lien doit être un lien interne"),
});

export async function getNotifications(clinicId: string) {
  // Z-70 — explicit authentication before any clinic-scoped read.
  await requireAuth();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const items = await db
      .select({
        id: notifications.id,
        category: notifications.category,
        title: notifications.title,
        message: notifications.message,
        link: notifications.link,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(eq(notifications.clinicId, clinicId))
      .orderBy(desc(notifications.createdAt))
      .limit(20);

    const [unread] = await db
      .select({ count: count() })
      .from(notifications)
      .where(and(eq(notifications.clinicId, clinicId), isNull(notifications.readAt)));

    return {
      unreadCount: unread?.count ?? 0,
      items,
    };
  } catch {
    return { unreadCount: 0, items: [] };
  }
}

export async function markNotificationsRead(clinicId: string): Promise<{ success: boolean }> {
  // Z-70 — explicit authentication before any clinic-scoped mutation.
  await requireAuth();
  await requireClinicAccessOrThrow(clinicId);

  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.clinicId, clinicId), isNull(notifications.readAt)));

    return { success: true };
  } catch {
    return { success: false };
  }
}

export async function createNotification(
  prevState: { error?: Record<string, string[]> } | { success: true } | undefined,
  formData: FormData,
): Promise<{ error?: Record<string, string[]> } | { success: true }> {
  const { owner } = await requirePlatformOwner();

  const validated = notificationSchema.safeParse({
    target: formData.get("target"),
    category: formData.get("category"),
    title: formData.get("title"),
    message: formData.get("message"),
    link: formData.get("link") || undefined,
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    let created: { id: string }[];

    if (data.target === "all") {
      // Z-69 — only clinics that still exist and are not soft-deleted.
      const clinicList = await db
        .select({ id: clinics.id })
        .from(clinics)
        .where(isNull(clinics.deletedAt))
        .orderBy(asc(clinics.name));

      if (clinicList.length === 0) {
        return { error: { general: ["Aucune clinique active à notifier"] } };
      }

      created = await db
        .insert(notifications)
        .values(
          clinicList.map((clinic) => ({
            clinicId: clinic.id,
            category: data.category,
            title: data.title,
            message: data.message,
            link: data.link || null,
            createdBy: owner.userId,
          })),
        )
        .returning({ id: notifications.id });
    } else {
      // Z-69 — the target must be an existing, non-deleted clinic.
      const clinicRows = await db
        .select({ id: clinics.id })
        .from(clinics)
        .where(and(eq(clinics.id, data.target), isNull(clinics.deletedAt)));

      if (!clinicRows[0]) {
        return { error: { target: ["Clinique introuvable ou désactivée"] } };
      }

      created = await db
        .insert(notifications)
        .values({
          clinicId: data.target,
          category: data.category,
          title: data.title,
          message: data.message,
          link: data.link || null,
          createdBy: owner.userId,
        })
        .returning({ id: notifications.id });
    }

    if (created[0]) {
      await logAction({
        clinicId: null,
        action: "create",
        entityType: "notification",
        entityId: created[0].id,
        after: {
          target: data.target,
          category: data.category,
          title: data.title,
          clinicsCount: created.length,
        },
      });
    }

    revalidatePath("/owner/notifications");
    return { success: true };
  } catch {
    return { error: { general: ["Erreur lors de l'envoi de la notification"] } };
  }
}
