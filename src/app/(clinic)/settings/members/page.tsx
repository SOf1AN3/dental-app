import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { clinicMemberships, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { InviteMemberForm } from "./invite-form";
import { MemberList } from "./member-list";

export default async function MembersSettingsPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const members = await db
    .select({
      id: clinicMemberships.id,
      userId: clinicMemberships.userId,
      role: clinicMemberships.role,
      createdAt: clinicMemberships.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(clinicMemberships)
    .innerJoin(users, eq(clinicMemberships.userId, users.id))
    .where(eq(clinicMemberships.clinicId, clinicId))
    .orderBy(users.name);

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Inviter un membre
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Ajoutez un dentiste, assistant ou réceptionniste à votre clinique.
        </p>
        <InviteMemberForm />
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Membres ({members.length})
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Gérez les niveaux d&apos;accès des membres de votre clinique.
        </p>
        <MemberList members={members} />
      </section>
    </div>
  );
}
