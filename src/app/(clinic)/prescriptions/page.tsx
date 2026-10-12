import Link from "next/link";
import { Plus } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescriptions } from "@/lib/actions/prescription";
import { PageHeader } from "@/components/ui/page-header";
import {
  PrescriptionTable,
  type PrescriptionTableRow,
} from "@/components/clinic/prescription-table";

export default async function PrescriptionsPage() {
  await requireAuth();
  await getCurrentClinicId();

  const prescriptionList = await getPrescriptions();

  // Seule la donnée plate traverse la frontière serveur/client :
  // aucun composant, aucune fonction, aucun `Date` manquant.
  const rows: PrescriptionTableRow[] = prescriptionList.map((rx) => ({
    id: rx.id,
    date: rx.date,
    status: rx.status,
    notes: rx.notes,
    patientId: rx.patient.id,
    patientFirstName: rx.patient.firstName,
    patientLastName: rx.patient.lastName,
  }));

  return (
    <div>
      <PageHeader
        title="Ordonnances"
        description={`${rows.length} ordonnance${rows.length !== 1 ? "s" : ""}`}
        actions={
          <Link
            href="/prescriptions/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Plus className="size-4" aria-hidden="true" />
            Nouvelle ordonnance
          </Link>
        }
      />

      <PrescriptionTable data={rows} />
    </div>
  );
}
