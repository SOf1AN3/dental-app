"use server";

import { db } from "@/lib/db/db";
import { clinicMemberships, users } from "@/lib/db/schema";
import { requireAuth, requireClinicAccessOrThrow, hasAbility } from "@/lib/auth-utils";
import { getCurrentClinicId, requireClinicAccess } from "@/lib/multi-tenant";
import { eq, and, count } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { getActivePlanLimits } from "./subscription";
import { logAction } from "@/lib/audit";

const inviteMemberSchema = z.object({
  email: z.string().email("Email invalide"),
  role: z.enum(["dentist", "assistant", "receptionist", "viewer"]),
});

export async function inviteMember(formData: FormData) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "members:invite"))) {
    return { error: "Seuls les propriétaires et dentistes peuvent inviter des membres" };
  }

  const validated = inviteMemberSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const { email, role } = validated.data;

  try {
    const invitedUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!invitedUser) {
      return { error: { email: ["Aucun utilisateur trouvé avec cet email"] } };
    }

    const existingMembership = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.userId, invitedUser.id),
        eq(clinicMemberships.clinicId, clinicId)
      ),
    });

    if (existingMembership) {
      return { error: { email: ["Cet utilisateur est déjà membre de cette clinique"] } };
    }

    const { maxStaff } = await getActivePlanLimits();

    const [memberCountResult] = await db
      .select({ count: count() })
      .from(clinicMemberships)
      .where(eq(clinicMemberships.clinicId, clinicId));

    const memberCount = memberCountResult?.count ?? 0;

    if (maxStaff != null && memberCount >= maxStaff) {
      return {
        error: {
          general: ["Limite de membres atteinte pour votre formule. Passez à un plan supérieur."],
        },
        paywall: true,
      };
    }

    await db.insert(clinicMemberships).values({
      userId: invitedUser.id,
      clinicId,
      role,
      invitedAt: new Date(),
    });

    await logAction({
      clinicId,
      action: "create",
      entityType: "clinic_membership",
      entityId: `${clinicId}:${invitedUser.id}`,
      after: { userId: invitedUser.id, role },
    });

    revalidatePath("/settings/members");
    revalidatePath("/select-clinic");
  } catch {
    return { error: { general: ["Erreur lors de l'invitation"] } };
  }
}

export async function removeMember(membershipId: string) {
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  const { user } = await requireClinicAccess(clinicId);

  if (!(await hasAbility(clinicId, "members:manage"))) {
    return { error: "Seul le propriétaire peut supprimer des membres" };
  }

  try {
    const target = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.id, membershipId),
        eq(clinicMemberships.clinicId, clinicId)
      ),
    });

    if (!target) return { error: "Membre introuvable" };
    if (target.role === "owner") return { error: "Impossible de supprimer le propriétaire" };

    await db.delete(clinicMemberships).where(eq(clinicMemberships.id, membershipId));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "clinic_membership",
      entityId: membershipId,
      before: { userId: target.userId, role: target.role },
    });

    if (target.userId === user.id) {
      const cookieStore = await cookies();
      cookieStore.delete("active_clinic_id");
    }

    revalidatePath("/settings/members");
  } catch {
    return { error: "Erreur lors de la suppression du membre" };
  }
}

export async function acceptInvitation(membershipId: string): Promise<{ error?: string } | { success?: boolean }> {
  const user = await requireAuth();

  try {
    const membership = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.id, membershipId),
        eq(clinicMemberships.userId, user.id)
      ),
    });

    if (!membership) return { error: "Invitation introuvable" };
    if (membership.joinedAt) return { error: "Invitation déjà acceptée" };

    await db.update(clinicMemberships)
      .set({ joinedAt: new Date() })
      .where(eq(clinicMemberships.id, membershipId));

    await logAction({
      clinicId: membership.clinicId,
      action: "update",
      entityType: "clinic_membership",
      entityId: membershipId,
      before: { joinedAt: null },
      after: { joinedAt: new Date().toISOString() },
    });

    revalidatePath("/select-clinic");
    return { success: true };
  } catch {
    return { error: "Erreur lors de l'acceptation" };
  }
}

export async function declineInvitation(membershipId: string): Promise<{ error?: string } | { success?: boolean }> {
  const user = await requireAuth();

  try {
    const membership = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.id, membershipId),
        eq(clinicMemberships.userId, user.id)
      ),
    });

    if (!membership) return { error: "Invitation introuvable" };

    await db.delete(clinicMemberships).where(eq(clinicMemberships.id, membershipId));

    await logAction({
      clinicId: membership.clinicId,
      action: "delete",
      entityType: "clinic_membership",
      entityId: membershipId,
      before: { role: membership.role, joinedAt: membership.joinedAt?.toISOString() ?? null },
    });

    revalidatePath("/select-clinic");
    return { success: true };
  } catch {
    return { error: "Erreur lors du refus" };
  }
}

export async function updateMemberRole(
  membershipId: string,
  role: string,
): Promise<{ error?: string } | { success?: boolean }> {
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "members:manage"))) {
    return { error: "Seul le propriétaire peut modifier les rôles" };
  }

  const validRoles = ["dentist", "assistant", "receptionist", "viewer"] as const;
  if (!validRoles.includes(role as typeof validRoles[number])) {
    return { error: "Rôle invalide" };
  }

  try {
    const [current] = await db
      .select({ role: clinicMemberships.role })
      .from(clinicMemberships)
      .where(and(
        eq(clinicMemberships.id, membershipId),
        eq(clinicMemberships.clinicId, clinicId)
      ))
      .limit(1);

    await db.update(clinicMemberships)
      .set({ role: role as typeof validRoles[number] })
      .where(and(
        eq(clinicMemberships.id, membershipId),
        eq(clinicMemberships.clinicId, clinicId)
      ));

    if (current) {
      await logAction({
        clinicId,
        action: "update",
        entityType: "clinic_membership",
        entityId: membershipId,
        before: { role: current.role },
        after: { role: role as typeof validRoles[number] },
      });
    }

    revalidatePath("/settings/members");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du rôle" };
  }
}
