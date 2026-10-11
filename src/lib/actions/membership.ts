"use server";

import { db } from "@/lib/db/db";
import { clinicMemberships, clinics, users } from "@/lib/db/schema";
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

    // Z-77 (extension) — cette action ne filtre PAS `joinedAt` : un owner
    // (toujours `joined`) pouvait donc l'invoquer avec SON propre
    // `membershipId` et supprimer sa membership → clinique sans aucun owner.
    // Même garde que `removeMember`, à l'identique.
    if (membership.role === "owner") {
      return { error: "Impossible de supprimer le propriétaire" };
    }

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
  type MemberRole = (typeof validRoles)[number];
  if (!validRoles.includes(role as MemberRole)) {
    return { error: "Rôle invalide" };
  }
  const nextRole: MemberRole = role as MemberRole;

  try {
    // Z-77 — garantie « au moins un owner » : l'interdiction de CRÉER un owner
    // n'empêchait pas de RÉTROGRADER le dernier owner existant, laissant la
    // clinique sans personne capable de gérer les membres. Lecture du rôle
    // courant, comptage des owners et écriture sont regroupés dans une
    // transaction verrouillée (`SELECT … FOR UPDATE` sur la ligne `clinics`) :
    // deux rétrogradations concurrentes sont sérialisées, la seconde recompte
    // (1 owner restant) et est refusée. Aucune modification de schéma.
    const outcome = await db.transaction(async (tx): Promise<
      { error: string } | { updated: true; beforeRole: string }
    > => {
      await tx
        .select({ id: clinics.id })
        .from(clinics)
        .where(eq(clinics.id, clinicId))
        .for("update");

      const [current] = await tx
        .select({ role: clinicMemberships.role })
        .from(clinicMemberships)
        .where(and(
          eq(clinicMemberships.id, membershipId),
          eq(clinicMemberships.clinicId, clinicId),
        ))
        .limit(1);

      if (!current) return { error: "Membre introuvable" };

      if (current.role === "owner") {
        const [ownerCountResult] = await tx
          .select({ count: count() })
          .from(clinicMemberships)
          .where(and(
            eq(clinicMemberships.clinicId, clinicId),
            eq(clinicMemberships.role, "owner"),
          ));

        const ownerCount = ownerCountResult?.count ?? 0;
        if (ownerCount <= 1) {
          return { error: "Impossible de rétrograder le dernier propriétaire" };
        }
      }

      const updatedRows = await tx
        .update(clinicMemberships)
        .set({ role: nextRole })
        .where(and(
          eq(clinicMemberships.id, membershipId),
          eq(clinicMemberships.clinicId, clinicId),
        ))
        .returning({ id: clinicMemberships.id });

      // 0 ligne : la membership a disparu entre la lecture et l'écriture →
      // ne pas annoncer un succès (avant : succès affiché sur 0 ligne).
      if (updatedRows.length === 0) return { error: "Membre introuvable" };

      return { updated: true, beforeRole: current.role };
    });

    if ("error" in outcome) {
      return { error: outcome.error };
    }

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_membership",
      entityId: membershipId,
      before: { role: outcome.beforeRole },
      after: { role: nextRole },
    });

    revalidatePath("/settings/members");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du rôle" };
  }
}
