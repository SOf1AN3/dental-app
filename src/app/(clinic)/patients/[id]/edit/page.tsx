import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { notFound } from "next/navigation";
import { PatientEditForm } from "@/components/clinic/patient-edit-form";

export default async function EditPatientPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Modifier le patient</h1>
        <p className="text-sm text-cool-500">
          {patient.lastName} {patient.firstName}
        </p>
      </div>
      <PatientEditForm patient={patient} />
    </div>
  );
}
