import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getTreatmentPlans } from "@/lib/actions/clinical";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TreatmentPlanStatusBadge } from "@/components/clinic/treatment-plan-status-badge";
import { PageHeader } from "@/components/ui/page-header";

export default async function TreatmentPlanListPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const plans = await getTreatmentPlans(id);

  return (
    <div>
      <div>
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          ← Retour au dossier patient
        </Link>
        <PageHeader
          title="Plans de traitement"
          actions={
            <Link
              href={`/patients/${id}/treatment-plan/new`}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              Nouveau plan
            </Link>
          }
        />
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border border-border-card bg-card p-12 text-center">
          <p className="text-sm text-muted-fg">
            Aucun plan de traitement
          </p>
          <Link
            href={`/patients/${id}/treatment-plan/new`}
            className="mt-4 inline-block rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Créer un plan de traitement
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => (
            <Link
              key={plan.id}
              href={`/patients/${id}/treatment-plan/${plan.id}`}
              className="block rounded-xl border border-border-card bg-card p-5 hover:border-cerulean hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {plan.title}
                  </h3>
                  {plan.description && (
                    <p className="text-sm text-muted-fg line-clamp-1">
                      {plan.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-fg">
                    {formatDate(plan.createdAt)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <TreatmentPlanStatusBadge status={plan.status} />
                  {plan.totalAmount != null && (
                    <span className="text-sm font-semibold text-foreground">
                      {formatCurrency(plan.totalAmount)}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
