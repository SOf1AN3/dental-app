import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getTreatmentPlans } from "@/lib/actions/clinical";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TreatmentPlanStatusBadge } from "@/components/clinic/treatment-plan-status-badge";

export default async function TreatmentPlanListPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const plans = await getTreatmentPlans(id);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href={`/patients/${id}`}
            className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
          >
            ← Retour au dossier patient
          </Link>
          <h1 className="text-2xl font-bold text-cool-900">
            Plans de traitement
          </h1>
        </div>
        <Link
          href={`/patients/${id}/treatment-plan/new`}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          Nouveau plan
        </Link>
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border border-cool-200 bg-white p-12 text-center">
          <p className="text-sm text-cool-400">
            Aucun plan de traitement
          </p>
          <Link
            href={`/patients/${id}/treatment-plan/new`}
            className="mt-4 inline-block rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light transition-colors"
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
              className="block rounded-xl border border-cool-200 bg-white p-5 hover:border-cerulean hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-cool-900">
                    {plan.title}
                  </h3>
                  {plan.description && (
                    <p className="text-sm text-cool-500 line-clamp-1">
                      {plan.description}
                    </p>
                  )}
                  <p className="text-xs text-cool-400">
                    {formatDate(plan.createdAt)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <TreatmentPlanStatusBadge status={plan.status} />
                  {plan.totalAmount != null && (
                    <span className="text-sm font-semibold text-cool-800">
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
