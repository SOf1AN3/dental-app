import { FlaskConical, Plus } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getLabs } from "@/lib/actions/prosthesis";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export default async function LabsPage() {
  await requireAuth();
  await getCurrentClinicId();

  const labs = await getLabs();

  return (
    <div>
      <PageHeader
        title="Laboratoires"
        description={`${labs.length} laboratoires`}
        actions={
          <Link
            href="/prostheses/labs/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nouveau laboratoire
          </Link>
        }
      />

      {labs.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="Aucun laboratoire"
          description={
            <>
              Ajoutez un{" "}
              <Link
                href="/prostheses/labs/new"
                className="text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                nouveau laboratoire
              </Link>{" "}
              pour commencer.
            </>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {labs.map((lab) => (
            <Link
              key={lab.id}
              href={`/prostheses/labs/${lab.id}`}
              className="rounded-xl border border-border-card bg-card p-6 hover:border-cerulean hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <h3 className="text-lg font-semibold text-foreground">{lab.name}</h3>
              {lab.contactPerson && (
                <p className="mt-1 text-sm text-muted-fg">{lab.contactPerson}</p>
              )}
              <div className="mt-4 space-y-1 text-sm text-muted-fg">
                {lab.phone && (
                  <p>
                    <span className="text-muted-fg">Tél: </span>
                    {lab.phone}
                  </p>
                )}
                {lab.email && (
                  <p>
                    <span className="text-muted-fg">Email: </span>
                    {lab.email}
                  </p>
                )}
                {lab.address && (
                  <p>
                    <span className="text-muted-fg">Adresse: </span>
                    {lab.address}
                  </p>
                )}
              </div>
              {!lab.phone && !lab.email && !lab.address && (
                <p className="mt-2 text-sm text-muted-fg">Aucune information de contact</p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
