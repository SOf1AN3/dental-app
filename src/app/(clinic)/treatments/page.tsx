import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { treatmentPlans, treatmentPlanItems, patients } from "@/lib/db/schema";
import { eq, desc, count } from "drizzle-orm";
import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import {
  TreatmentPlanTable,
  type TreatmentPlanTableRow,
} from "@/components/clinic/treatment-table";

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

  // Seule la donnée plate traverse la frontière serveur/client :
  // aucun composant, aucune fonction, aucun formatage calculé ici.
  const rows: TreatmentPlanTableRow[] = plansWithCounts.map(
    ({ plan, patient, itemsCount }) => ({
      id: plan.id,
      patientId: plan.patientId,
      patientFirstName: patient.firstName,
      patientLastName: patient.lastName,
      title: plan.title,
      status: plan.status,
      itemsCount,
      totalAmount: plan.totalAmount,
      createdAt: plan.createdAt,
    }),
  );

  return (
    <div>
      <PageHeader
        title="Traitements"
        description={`${plansWithCounts.length} plan${plansWithCounts.length !== 1 ? "s" : ""} de traitement`}
        actions={
          <Link
            href="/patients"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Plus className="size-4" aria-hidden="true" />
            Nouveau plan de traitement
          </Link>
        }
      />

      <TreatmentPlanTable data={rows} />
    </div>
  );
}
