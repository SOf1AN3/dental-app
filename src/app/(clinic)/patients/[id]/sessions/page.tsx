import Link from "next/link";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getSessions } from "@/lib/actions/session";
import { PageHeader } from "@/components/ui/page-header";
import {
  PatientSessionTable,
  type PatientSessionTableRow,
} from "@/components/clinic/patient-session-table";

export default async function PatientSessionsPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const sessions = await getSessions(id);

  // Seule la donnée plate traverse la frontière serveur/client :
  // aucune fonction, aucun composant, aucune relation Drizzle.
  const rows: PatientSessionTableRow[] = sessions.map((session) => ({
    id: session.id,
    patientId: session.patientId,
    createdAt: session.createdAt,
    status: session.status,
    totalAmount: session.totalAmount,
    invoiceId: session.invoice?.id ?? null,
    invoiceNumber: session.invoice?.number ?? null,
  }));

  return (
    <div>
      <div>
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier
        </Link>
        <PageHeader
          title="Séances cliniques"
          description={`${rows.length} séance${rows.length !== 1 ? "s" : ""}`}
        />
      </div>

      <PatientSessionTable data={rows} />
    </div>
  );
}
