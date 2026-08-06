import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOdontogramState } from "@/lib/actions/odontogram";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
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
      <div className="mb-6">
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">
          Odontogramme — {patient.lastName} {patient.firstName}
        </h1>
      </div>

      <OdontogramEditor
        patientId={id}
        initialState={saved?.state}
        initialVersion={saved?.version ?? 0}
      />
    </div>
  );
}
