import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { treatmentPlans, treatmentPlanItems, patients } from "@/lib/db/schema";
import { eq, desc, count } from "drizzle-orm";
import { formatCurrency, formatDate } from "@/lib/utils";
import { TreatmentPlanStatusBadge } from "@/components/clinic/treatment-plan-status-badge";
import Link from "next/link";

export default async function TreatmentsPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const plansWithPatients = await db
    .select({
      plan: treatmentPlans,
      patient: patients,
    })
    .from(treatmentPlans)
    .innerJoin(patients, eq(treatmentPlans.patientId, patients.id))
    .where(eq(treatmentPlans.clinicId, clinicId))
    .orderBy(desc(treatmentPlans.createdAt));

  const plansWithCounts = await Promise.all(
    plansWithPatients.map(async ({ plan, patient }) => {
      const [result] = await db
        .select({ count: count() })
        .from(treatmentPlanItems)
        .where(eq(treatmentPlanItems.planId, plan.id));
      return { plan, patient, itemsCount: result.count };
    })
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Traitements</h1>
          <p className="text-sm text-cool-500">{plansWithCounts.length} plan{plansWithCounts.length !== 1 ? "s" : ""} de traitement</p>
        </div>
        <Link
          href="/patients"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouveau plan de traitement
        </Link>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Patient
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Titre
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Statut
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Articles
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Montant
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Date
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {plansWithCounts.map(({ plan, patient, itemsCount }) => (
              <tr
                key={plan.id}
                className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
              >
                <td className="px-4 py-3 font-medium text-cool-900">
                  <Link
                    href={`/patients/${plan.patientId}/treatment-plan/${plan.id}`}
                    className="text-cerulean hover:text-cerulean/80"
                  >
                    {patient.lastName} {patient.firstName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-cool-700 max-w-xs truncate">
                  {plan.title}
                </td>
                <td className="px-4 py-3">
                  <TreatmentPlanStatusBadge status={plan.status} />
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {itemsCount}
                </td>
                <td className="px-4 py-3 text-cool-900 font-medium">
                  {plan.totalAmount != null
                    ? formatCurrency(plan.totalAmount)
                    : "-"}
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {formatDate(plan.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/patients/${plan.patientId}/treatment-plan/${plan.id}`}
                    className="text-sm text-cerulean hover:text-cerulean/80"
                  >
                    Détails
                  </Link>
                </td>
              </tr>
            ))}
            {plansWithCounts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-cool-400">
                  Aucun plan de traitement
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
