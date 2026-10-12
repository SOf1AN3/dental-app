import Link from "next/link";
import { Plus } from "lucide-react";
import { notFound } from "next/navigation";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescriptions } from "@/lib/actions/prescription";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import {
  PatientPrescriptionTable,
  type PatientPrescriptionTableRow,
} from "@/components/clinic/patient-prescription-table";

export default async function PatientPrescriptionsPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const prescriptionList = await getPrescriptions(id);

  // Seule la donnée plate traverse la frontière serveur/client :
  // aucun composant, aucune fonction, aucun `Date` manquant.
  const rows: PatientPrescriptionTableRow[] = prescriptionList.map((rx) => ({
    id: rx.id,
    date: rx.date,
    status: rx.status,
    notes: rx.notes,
  }));

  return (
    <div>
      <div>
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier patient
        </Link>
        <PageHeader
          title={`Ordonnances — ${patient.lastName} ${patient.firstName}`}
          description={`${rows.length} ordonnance${rows.length !== 1 ? "s" : ""}`}
          actions={
            <Link
              href={`/prescriptions/new?patientId=${id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <Plus className="size-4" aria-hidden="true" />
              Nouvelle ordonnance
            </Link>
          }
        />
      </div>

      <PatientPrescriptionTable
        data={rows}
        emptyAction={
          <Link
            href={`/prescriptions/new?patientId=${id}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Plus className="size-4" aria-hidden="true" />
            Créer une ordonnance
          </Link>
        }
      />
    </div>
  );
}
