import { auth } from "@/lib/auth";
import { db } from "@/lib/db/db";
import { clinicMemberships, clinics } from "@/lib/db/schema";
import { eq, and, or, isNull, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { CreateClinicDialog } from "./create-clinic-dialog";
import { ClinicCard } from "./clinic-card";
import { PendingInvitations } from "./pending-invitations";

export default async function SelectClinicPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

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
          <h1 className="text-3xl font-bold text-primary">DentalCare</h1>
          <p className="mt-2 text-cool-500">
            Sélectionnez une clinique ou créez-en une nouvelle
          </p>
        </div>

        {pendingInvites.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider">
              Invitations en attente
            </h2>
            <PendingInvitations invites={pendingInvites} />
          </div>
        )}

        {memberships.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider">
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
          <div className="rounded-xl border-2 border-dashed border-cool-200 bg-white dark:bg-cool-100 p-12 text-center">
            <p className="text-lg font-medium text-cool-600">
              Vous n&apos;avez aucune clinique
            </p>
            <p className="mt-1 text-sm text-cool-400">
              Créez votre première clinique pour commencer
            </p>
          </div>
        )}

        <div className="flex justify-center">
          <CreateClinicDialog />
        </div>
      </div>
    </div>
  );
}
