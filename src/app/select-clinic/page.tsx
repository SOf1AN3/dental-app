import { Building2 } from "lucide-react";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/db";
import { clinicMemberships, clinics, platformOwners } from "@/lib/db/schema";
import { eq, and, or, isNull, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { CreateClinicDialog } from "./create-clinic-dialog";
import { ClinicCard } from "./clinic-card";
import { PendingInvitations } from "./pending-invitations";

export default async function SelectClinicPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Platform owners go straight to the owner dashboard
  const platformOwner = await db.query.platformOwners.findFirst({
    where: eq(platformOwners.userId, session.user.id),
  });
  if (platformOwner) {
    redirect("/owner");
  }

  // Active memberships: directly added (invitedAt is null) or accepted an invitation (joinedAt is set)
  const memberships = await db
    .select({
      membership: clinicMemberships,
      clinic: clinics,
    })
    .from(clinicMemberships)
    .innerJoin(clinics, eq(clinicMemberships.clinicId, clinics.id))
    .where(
      and(
        eq(clinicMemberships.userId, session.user.id),
        isNull(clinics.deletedAt),
        or(
          isNull(clinicMemberships.invitedAt),
          isNotNull(clinicMemberships.joinedAt)
        )
      )
    );

  // Pending invitations: invited but not yet accepted
  const pendingInvites = await db
    .select({
      membership: clinicMemberships,
      clinic: clinics,
    })
    .from(clinicMemberships)
    .innerJoin(clinics, eq(clinicMemberships.clinicId, clinics.id))
    .where(
      and(
        eq(clinicMemberships.userId, session.user.id),
        isNotNull(clinicMemberships.invitedAt),
        isNull(clinicMemberships.joinedAt)
      )
    );

  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center">
          {/* Hero de sélection de clinique : titre de marque centré (text-primary),
              volontairement distinct d'un PageHeader applicatif standard. */}
          <h1 className="text-3xl font-bold text-primary">DentalCare</h1>
          <p className="mt-2 text-muted-fg">
            Sélectionnez une clinique ou créez-en une nouvelle
          </p>
        </div>

        {pendingInvites.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider">
              Invitations en attente
            </h2>
            <PendingInvitations invites={pendingInvites} />
          </div>
        )}

        {memberships.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider">
              Mes cliniques
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {memberships.map(({ membership, clinic }) => (
                <ClinicCard
                  key={clinic.id}
                  clinic={clinic}
                  role={membership.role}
                />
              ))}
            </div>
          </div>
        )}

        {memberships.length === 0 && pendingInvites.length === 0 && (
          <EmptyState
            icon={Building2}
            title="Vous n'avez aucune clinique"
            description="Créez votre première clinique pour commencer"
            className="rounded-xl border-2 border-dashed border-border-card"
          />
        )}

        <div className="flex justify-center">
          <CreateClinicDialog />
        </div>
      </div>
    </div>
  );
}
