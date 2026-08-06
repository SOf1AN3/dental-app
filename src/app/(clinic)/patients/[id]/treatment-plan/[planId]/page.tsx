import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getTreatmentPlan } from "@/lib/actions/clinical";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TreatmentPlanStatusBadge } from "@/components/clinic/treatment-plan-status-badge";

export default async function TreatmentPlanDetailPage(props: {
  params: Promise<{ id: string; planId: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id, planId } = await props.params;

  const plan = await getTreatmentPlan(planId);

  if (!plan) notFound();

  const itemTotal = (item: { fee: number; quantity: number; discount: number | null }) => {
    const discount = item.discount ?? 0;
    return item.fee * item.quantity - discount;
  };

  const grandTotal = (plan.totalAmount ?? 0) - (plan.discount ?? 0);

  return (
    <div>
      <div className="mb-6">
        <Link
          href={`/patients/${id}/treatment-plan`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour aux plans de traitement
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">{plan.title}</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-cool-200 bg-white p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Détails
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-cool-400">Statut</dt>
                <dd className="mt-0.5">
                  <TreatmentPlanStatusBadge status={plan.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Total</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {plan.totalAmount != null
                    ? formatCurrency(plan.totalAmount)
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Remise</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {plan.discount != null
                    ? formatCurrency(plan.discount)
                    : "-"}
                </dd>
              </div>
              {plan.totalAmount != null && (
                <div>
                  <dt className="text-xs text-cool-400">Net à payer</dt>
                  <dd className="text-sm font-semibold text-cool-900">
                    {formatCurrency(grandTotal)}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-cool-400">Créé le</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {formatDate(plan.createdAt)}
                </dd>
              </div>
            </dl>
          </div>

          {plan.description && (
            <div className="rounded-xl border border-cool-200 bg-white p-6">
              <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-2">
                Description
              </h2>
              <p className="text-sm text-cool-700 whitespace-pre-wrap">
                {plan.description}
              </p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl border border-cool-200 bg-white p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Actes prévus
            </h2>

            {plan.items.length === 0 ? (
              <p className="text-sm text-cool-400 py-8 text-center">
                Aucun acte ajouté à ce plan
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-cool-200">
                      <th className="text-left py-2 pr-4 font-medium text-cool-500">Dent</th>
                      <th className="text-left py-2 pr-4 font-medium text-cool-500">Face</th>
                      <th className="text-left py-2 pr-4 font-medium text-cool-500">Code</th>
                      <th className="text-left py-2 pr-4 font-medium text-cool-500">Description</th>
                      <th className="text-right py-2 pr-4 font-medium text-cool-500">Honoraire</th>
                      <th className="text-right py-2 pr-4 font-medium text-cool-500">Qté</th>
                      <th className="text-right py-2 pr-4 font-medium text-cool-500">Remise</th>
                      <th className="text-right py-2 font-medium text-cool-500">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.items.map((item) => (
                      <tr key={item.id} className="border-b border-cool-100 last:border-0">
                        <td className="py-2.5 pr-4 text-cool-900">
                          {item.toothNumber ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-cool-900">
                          {item.surface ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-cool-900">
                          {item.procedureCode ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-cool-700">
                          {item.description}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-cool-900">
                          {formatCurrency(item.fee)}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-cool-900">
                          {item.quantity}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-cool-900">
                          {item.discount != null
                            ? formatCurrency(item.discount)
                            : "-"}
                        </td>
                        <td className="py-2.5 text-right font-medium text-cool-900">
                          {formatCurrency(itemTotal(item))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
