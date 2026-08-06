"use server";

import { db } from "@/lib/db/db";
import {
  clinics,
  clinicSubscriptions,
  subscriptionPlans,
  supportTickets,
} from "@/lib/db/schema";
import { requirePlatformOwner } from "@/lib/auth-utils";
import { eq, and, desc, count, sql, isNull, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAction } from "@/lib/audit";

const subscriptionPlanSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  code: z.string().min(1, "Code requis"),
  priceMonthly: z.coerce.number().positive("Le prix mensuel doit être positif"),
  priceYearly: z.coerce.number().positive("Le prix annuel doit être positif").optional().nullable(),
  maxStaff: z.coerce.number().int().positive("Le nombre max de staff doit être positif").optional().nullable(),
  maxPatients: z.coerce.number().int().positive("Le nombre max de patients doit être positif").optional().nullable(),
});

export async function getOwnerStats() {
  await requirePlatformOwner();

  try {
    const [clinicCount, subscriptionCount, openTickets, totalRevenue] = await Promise.all([
      db.select({ count: count() }).from(clinics).where(and(eq(clinics.status, "active"), isNull(clinics.deletedAt))),
      db.select({ count: count() }).from(clinicSubscriptions).where(eq(clinicSubscriptions.status, "active")),
      db.select({ count: count() }).from(supportTickets).where(eq(supportTickets.status, "open")),
      db.select({ total: sql<number>`COALESCE(SUM(${subscriptionPlans.priceMonthly}), 0)::float8` }).from(clinicSubscriptions).innerJoin(subscriptionPlans, eq(clinicSubscriptions.planId, subscriptionPlans.id)).where(eq(clinicSubscriptions.status, "active")),
    ])

    return {
      activeClinics: clinicCount[0]?.count ?? 0,
      activeSubscriptions: subscriptionCount[0]?.count ?? 0,
      openTickets: openTickets[0]?.count ?? 0,
      monthlyRevenue: totalRevenue[0]?.total ?? 0,
    }
  } catch {
    return {
      activeClinics: 0,
      activeSubscriptions: 0,
      openTickets: 0,
      monthlyRevenue: 0,
    }
  }
}

export async function getClinics() {
  await requirePlatformOwner();

  try {
    return await db
      .select()
      .from(clinics)
      .where(isNull(clinics.deletedAt))
      .orderBy(desc(clinics.createdAt));
  } catch {
    return [];
  }
}

export async function getArchivedClinics() {
  await requirePlatformOwner();

  try {
    const rows = await db
      .select()
      .from(clinics)
      .where(isNotNull(clinics.deletedAt))
      .orderBy(desc(clinics.deletedAt));

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return rows.map((clinic) => ({
      ...clinic,
      restorable: clinic.deletedAt ? clinic.deletedAt.getTime() > cutoff : false,
    }));
  } catch {
    return [];
  }
}

export async function toggleClinicStatus(
  clinicId: string,
  newStatus: "active" | "suspended" | "trial",
): Promise<{ error?: string } | { success?: boolean }> {
  await requirePlatformOwner();

  try {
    const [clinic] = await db
      .select({ id: clinics.id, status: clinics.status })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    await db
      .update(clinics)
      .set({ status: newStatus })
      .where(eq(clinics.id, clinicId));

    if (clinic) {
      await logAction({
        clinicId: null,
        action: "status_change",
        entityType: "clinic",
        entityId: clinicId,
        before: { status: clinic.status },
        after: { status: newStatus },
      });
    }

    revalidatePath("/owner/clinics");
    return { success: true };
  } catch {
    return { error: "Erreur lors du changement de statut" };
  }
}

export async function getSubscriptionPlans() {
  await requirePlatformOwner();

  try {
    return await db
      .select()
      .from(subscriptionPlans)
      .orderBy(desc(subscriptionPlans.createdAt));
  } catch {
    return [];
  }
}

export async function createSubscriptionPlan(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requirePlatformOwner();

  const validated = subscriptionPlanSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code"),
    priceMonthly: formData.get("priceMonthly"),
    priceYearly: formData.get("priceYearly") || null,
    maxStaff: formData.get("maxStaff") || null,
    maxPatients: formData.get("maxPatients") || null,
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [created] = await db.insert(subscriptionPlans).values({
      name: data.name,
      code: data.code,
      priceMonthly: data.priceMonthly,
      priceYearly: data.priceYearly ?? null,
      maxStaff: data.maxStaff ?? null,
      maxPatients: data.maxPatients ?? null,
      features: {},
      isActive: true,
    }).returning({ id: subscriptionPlans.id });

    if (created) {
      await logAction({
        clinicId: null,
        action: "create",
        entityType: "subscription_plan",
        entityId: created.id,
        after: {
          name: data.name,
          code: data.code,
          priceMonthly: data.priceMonthly,
          isActive: true,
        },
      });
    }

    revalidatePath("/owner/plans");
  } catch {
    return { error: { general: ["Erreur lors de la création du plan"] } };
  }
}

export async function togglePlanActive(
  planId: string,
  isActive: boolean,
): Promise<{ error?: string } | { success?: boolean }> {
  await requirePlatformOwner();

  try {
    const [plan] = await db
      .select({ id: subscriptionPlans.id, isActive: subscriptionPlans.isActive })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    await db
      .update(subscriptionPlans)
      .set({ isActive })
      .where(eq(subscriptionPlans.id, planId));

    if (plan) {
      await logAction({
        clinicId: null,
        action: "status_change",
        entityType: "subscription_plan",
        entityId: planId,
        before: { isActive: plan.isActive },
        after: { isActive },
      });
    }

    revalidatePath("/owner/plans");
    return { success: true };
  } catch {
    return { error: "Erreur lors du changement de statut" };
  }
}

export async function getSupportTickets() {
  await requirePlatformOwner();

  try {
    return await db
      .select()
      .from(supportTickets)
      .orderBy(desc(supportTickets.createdAt));
  } catch {
    return [];
  }
}

export async function updateTicketStatus(
  ticketId: string,
  status: "open" | "in_progress" | "resolved" | "closed",
): Promise<{ error?: string } | { success?: boolean }> {
  await requirePlatformOwner();

  try {
    const [ticket] = await db
      .select({ id: supportTickets.id, status: supportTickets.status })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);

    await db
      .update(supportTickets)
      .set({
        status,
        resolvedAt: status === "resolved" || status === "closed" ? new Date() : undefined,
      })
      .where(eq(supportTickets.id, ticketId));

    if (ticket) {
      await logAction({
        clinicId: null,
        action: "status_change",
        entityType: "support_ticket",
        entityId: ticketId,
        before: { status: ticket.status },
        after: { status },
      });
    }

    revalidatePath("/owner/support");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du ticket" };
  }
}

export async function toggleClinicStatusAction(formData: FormData): Promise<{ error?: string } | { success?: boolean }> {
  "use server";
  const clinicId = formData.get("clinicId") as string;
  const newStatus = formData.get("newStatus") as "active" | "suspended" | "trial";
  return toggleClinicStatus(clinicId, newStatus);
}

export async function archiveClinic(clinicId: string) {
  await requirePlatformOwner();

  try {
    const [clinic] = await db
      .select({ deletedAt: clinics.deletedAt })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    await db
      .update(clinics)
      .set({ deletedAt: new Date() })
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId: null,
      action: "update",
      entityType: "clinic",
      entityId: clinicId,
      before: { deletedAt: clinic?.deletedAt?.toISOString() ?? null },
      after: { deletedAt: new Date().toISOString() },
    });

    revalidatePath("/owner/clinics");
    revalidatePath("/owner");
    return { success: true };
  } catch {
    return { error: "Erreur lors de l'archivage de la clinique" };
  }
}

export async function restoreClinic(clinicId: string) {
  await requirePlatformOwner();

  try {
    const [clinic] = await db
      .select()
      .from(clinics)
      .where(eq(clinics.id, clinicId));

    const deletedAt = clinic?.deletedAt;
    if (!deletedAt || Date.now() - deletedAt.getTime() > 30 * 24 * 60 * 60 * 1000) {
      return { error: "Fenêtre de restauration expirée" };
    }

    await db
      .update(clinics)
      .set({ deletedAt: null })
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId: null,
      action: "update",
      entityType: "clinic",
      entityId: clinicId,
      before: { deletedAt: clinic?.deletedAt?.toISOString() ?? null },
      after: { deletedAt: null },
    });

    revalidatePath("/owner/clinics");
    revalidatePath("/owner");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la restauration de la clinique" };
  }
}

export async function updateSubscriptionPlan(
  planId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requirePlatformOwner();

  const validated = subscriptionPlanSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code"),
    priceMonthly: formData.get("priceMonthly"),
    priceYearly: formData.get("priceYearly") || null,
    maxStaff: formData.get("maxStaff") || null,
    maxPatients: formData.get("maxPatients") || null,
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        name: subscriptionPlans.name,
        code: subscriptionPlans.code,
        priceMonthly: subscriptionPlans.priceMonthly,
        priceYearly: subscriptionPlans.priceYearly,
        maxStaff: subscriptionPlans.maxStaff,
        maxPatients: subscriptionPlans.maxPatients,
      })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    await db
      .update(subscriptionPlans)
      .set({
        name: data.name,
        code: data.code,
        priceMonthly: data.priceMonthly,
        priceYearly: data.priceYearly ?? null,
        maxStaff: data.maxStaff ?? null,
        maxPatients: data.maxPatients ?? null,
      })
      .where(eq(subscriptionPlans.id, planId));

    if (current) {
      await logAction({
        clinicId: null,
        action: "update",
        entityType: "subscription_plan",
        entityId: planId,
        before: {
          name: current.name,
          code: current.code,
          priceMonthly: current.priceMonthly,
          priceYearly: current.priceYearly ?? null,
          maxStaff: current.maxStaff ?? null,
          maxPatients: current.maxPatients ?? null,
        },
        after: {
          name: data.name,
          code: data.code,
          priceMonthly: data.priceMonthly,
          priceYearly: data.priceYearly ?? null,
          maxStaff: data.maxStaff ?? null,
          maxPatients: data.maxPatients ?? null,
        },
      });
    }

    revalidatePath("/owner/plans");
  } catch {
    return { error: { general: ["Erreur lors de la mise à jour du plan"] } };
  }
}

export async function deleteSubscriptionPlan(planId: string): Promise<{ error?: string } | { success?: boolean }> {
  await requirePlatformOwner();

  try {
    const [plan] = await db
      .select({ name: subscriptionPlans.name, code: subscriptionPlans.code })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    await db
      .delete(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId));

    if (plan) {
      await logAction({
        clinicId: null,
        action: "delete",
        entityType: "subscription_plan",
        entityId: planId,
        before: { name: plan.name, code: plan.code },
      });
    }

    revalidatePath("/owner/plans");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la suppression du plan" };
  }
}

export async function togglePlanActiveAction(formData: FormData): Promise<{ error?: string } | { success?: boolean }> {
  "use server";
  const planId = formData.get("planId") as string;
  const isActive = formData.get("isActive") === "true";
  return togglePlanActive(planId, isActive);
}

export async function getBillingData() {
  await requirePlatformOwner();

  try {
    return await db
      .select({
        id: clinicSubscriptions.id,
        clinicId: clinicSubscriptions.clinicId,
        clinicName: clinics.name,
        planName: subscriptionPlans.name,
        startDate: clinicSubscriptions.startDate,
        endDate: clinicSubscriptions.endDate,
        status: clinicSubscriptions.status,
      })
      .from(clinicSubscriptions)
      .innerJoin(clinics, eq(clinicSubscriptions.clinicId, clinics.id))
      .innerJoin(subscriptionPlans, eq(clinicSubscriptions.planId, subscriptionPlans.id))
      .orderBy(desc(clinicSubscriptions.createdAt));
  } catch {
    return [];
  }
}
