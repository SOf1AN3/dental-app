import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getTreatmentPlan } from "@/lib/actions/clinical";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TreatmentPlanStatusBadge } from "@/components/clinic/treatment-plan-status-badge";
import { PageHeader } from "@/components/ui/page-header";

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
      <div>
        <Link
          href={`/patients/${id}/treatment-plan`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          ← Retour aux plans de traitement
        </Link>
        <PageHeader title={plan.title} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Détails
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-muted-fg">Statut</dt>
                <dd className="mt-0.5">
                  <TreatmentPlanStatusBadge status={plan.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Total</dt>
                <dd className="text-sm font-medium text-foreground">
                  {plan.totalAmount != null
                    ? formatCurrency(plan.totalAmount)
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Remise</dt>
                <dd className="text-sm font-medium text-foreground">
                  {plan.discount != null
                    ? formatCurrency(plan.discount)
                    : "-"}
                </dd>
              </div>
              {plan.totalAmount != null && (
                <div>
                  <dt className="text-xs text-muted-fg">Net à payer</dt>
                  <dd className="text-sm font-semibold text-foreground">
                    {formatCurrency(grandTotal)}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted-fg">Créé le</dt>
                <dd className="text-sm font-medium text-foreground">
                  {formatDate(plan.createdAt)}
                </dd>
              </div>
            </dl>
          </div>

          {plan.description && (
            <div className="rounded-xl border border-border-card bg-card p-6">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-2">
                Description
              </h2>
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {plan.description}
              </p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Actes prévus
            </h2>

            {plan.items.length === 0 ? (
              <p className="text-sm text-muted-fg py-8 text-center">
                Aucun acte ajouté à ce plan
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-card">
                      <th scope="col" className="text-left py-2 pr-4 font-medium text-muted-fg">Dent</th>
                      <th scope="col" className="text-left py-2 pr-4 font-medium text-muted-fg">Face</th>
                      <th scope="col" className="text-left py-2 pr-4 font-medium text-muted-fg">Code</th>
                      <th scope="col" className="text-left py-2 pr-4 font-medium text-muted-fg">Description</th>
                      <th scope="col" className="text-right py-2 pr-4 font-medium text-muted-fg">Honoraire</th>
                      <th scope="col" className="text-right py-2 pr-4 font-medium text-muted-fg">Qté</th>
                      <th scope="col" className="text-right py-2 pr-4 font-medium text-muted-fg">Remise</th>
                      <th scope="col" className="text-right py-2 font-medium text-muted-fg">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.items.map((item) => (
                      <tr key={item.id} className="border-b border-border-card last:border-0">
                        <td className="py-2.5 pr-4 text-foreground">
                          {item.toothNumber ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-foreground">
                          {item.surface ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-foreground">
                          {item.procedureCode ?? "-"}
                        </td>
                        <td className="py-2.5 pr-4 text-foreground">
                          {item.description}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-foreground">
                          {formatCurrency(item.fee)}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-foreground">
                          {item.quantity}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-foreground">
                          {item.discount != null
                            ? formatCurrency(item.discount)
                            : "-"}
                        </td>
                        <td className="py-2.5 text-right font-medium text-foreground">
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
