"use server";

import { db } from "@/lib/db/db";
import { clinicSubscriptions, subscriptionPlans, clinics } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logAction } from "@/lib/audit";

const DEFAULT_MAX_STAFF = 2;
const DEFAULT_MAX_PATIENTS = 50;

export async function getActivePlan() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const sub = await db.query.clinicSubscriptions.findFirst({
      where: and(
        eq(clinicSubscriptions.clinicId, clinicId),
        eq(clinicSubscriptions.status, "active"),
      ),
      orderBy: [desc(clinicSubscriptions.createdAt)],
      with: { plan: true },
    });
    return sub;
  } catch {
    return null;
  }
}

export async function getActivePlanLimits(): Promise<{
  maxStaff: number | null;
  maxPatients: number | null;
  planName: string | null;
}> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const sub = await db.query.clinicSubscriptions.findFirst({
      where: and(
        eq(clinicSubscriptions.clinicId, clinicId),
        eq(clinicSubscriptions.status, "active"),
      ),
      orderBy: [desc(clinicSubscriptions.createdAt)],
      with: { plan: true },
    });

    if (!sub?.plan) {
      return {
        maxStaff: DEFAULT_MAX_STAFF,
        maxPatients: DEFAULT_MAX_PATIENTS,
        planName: null,
      };
    }

    return {
      maxStaff: sub.plan.maxStaff,
      maxPatients: sub.plan.maxPatients,
      planName: sub.plan.name,
    };
  } catch {
    return {
      maxStaff: DEFAULT_MAX_STAFF,
      maxPatients: DEFAULT_MAX_PATIENTS,
      planName: null,
    };
  }
}

export async function subscribeToPlan(formData: FormData) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const planId = formData.get("planId");
  if (!planId || typeof planId !== "string") {
    return { error: "Identifiant de formule requis" };
  }

  try {
    // Check the plan exists and is active
    const plan = await db.query.subscriptionPlans.findFirst({
      where: and(
        eq(subscriptionPlans.id, planId),
        eq(subscriptionPlans.isActive, true),
      ),
    });

    if (!plan) {
      return { error: "Formule introuvable ou inactive" };
    }

    // Check if clinic already has an active subscription
    const existingSub = await db.query.clinicSubscriptions.findFirst({
      where: and(
        eq(clinicSubscriptions.clinicId, clinicId),
        eq(clinicSubscriptions.status, "active"),
      ),
    });

    if (existingSub) {
      // End the previous subscription
      await db
        .update(clinicSubscriptions)
        .set({ status: "cancelled", endDate: new Date() })
        .where(eq(clinicSubscriptions.id, existingSub.id));
    }

    // Create new subscription
    const [newSub] = await db.insert(clinicSubscriptions).values({
      clinicId,
      planId,
      startDate: new Date(),
      status: "active",
    }).returning({ id: clinicSubscriptions.id });

    // Update clinic status from "trial" to "active"
    await db
      .update(clinics)
      .set({ status: "active" })
      .where(eq(clinics.id, clinicId));

    if (newSub) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "clinic_subscription",
        entityId: newSub.id,
        after: { planId, status: "active" },
      });
    }

    revalidatePath("/settings/subscription");
  } catch {
    return { error: "Erreur lors de la souscription" };
  }
  redirect("/settings/subscription");
}

export async function cancelSubscription() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const existingSub = await db.query.clinicSubscriptions.findFirst({
      where: and(
        eq(clinicSubscriptions.clinicId, clinicId),
        eq(clinicSubscriptions.status, "active"),
      ),
    });

    if (!existingSub) {
      return { error: "Aucun abonnement actif trouvé" };
    }

    await db
      .update(clinicSubscriptions)
      .set({ status: "cancelled", endDate: new Date() })
      .where(eq(clinicSubscriptions.id, existingSub.id));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "clinic_subscription",
      entityId: existingSub.id,
      before: { status: existingSub.status },
      after: { status: "cancelled", endDate: new Date().toISOString() },
    });

    revalidatePath("/settings/subscription");
  } catch {
    return { error: "Erreur lors de l'annulation de l'abonnement" };
  }
  redirect("/settings/subscription");
}
