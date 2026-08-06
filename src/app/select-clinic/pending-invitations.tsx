import { acceptInvitation, declineInvitation } from "@/lib/actions/membership";
import type { clinicMemberships, clinics } from "@/lib/db/schema";

interface PendingInvitationsProps {
  invites: Array<{
    membership: typeof clinicMemberships.$inferSelect;
    clinic: typeof clinics.$inferSelect;
  }>;
}

export function PendingInvitations({ invites }: PendingInvitationsProps) {
  return (
    <div className="space-y-3">
      {invites.map(({ membership, clinic }) => (
        <div
          key={membership.id}
          className="flex items-center justify-between rounded-xl border border-amber/20 bg-amber/5 p-4"
        >
          <div>
            <p className="font-medium text-cool-900">{clinic.name}</p>
            <p className="text-sm text-cool-500">
              Invitation en tant que {membership.role}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <form
              action={declineInvitation.bind(
                null,
                membership.id,
              ) as unknown as (formData: FormData) => void}
            >
              <button
                type="submit"
                className="rounded-lg border border-cool-200 px-3 py-1.5 text-sm font-medium text-cool-600 hover:bg-white transition-colors"
              >
                Refuser
              </button>
            </form>
            <form
              action={acceptInvitation.bind(
                null,
                membership.id,
              ) as unknown as (formData: FormData) => void}
            >
              <button
                type="submit"
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-light transition-colors"
              >
                Accepter
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}
