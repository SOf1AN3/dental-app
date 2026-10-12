import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOdontogramState } from "@/lib/actions/odontogram";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import OdontogramEditor from "@/components/clinic/odontogram-editor";

export default async function DentalChartPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const saved = await getOdontogramState(id);

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
          title={`Odontogramme — ${patient.lastName} ${patient.firstName}`}
        />
      </div>

      <OdontogramEditor
        patientId={id}
        initialState={saved?.state}
        initialVersion={saved?.version ?? 0}
      />
    </div>
  );
}
