import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription } from "@/lib/actions/prescription";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { PrescriptionEditor } from "@/components/clinic/prescription-editor";
import type { A5Item } from "@/components/clinic/a5-prescription";
import { buildA5Template } from "@/lib/document-branding";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";
import Link from "next/link";

export default async function EditPrescriptionPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const [rx, clinic, profile] = await Promise.all([
    getPrescription(id),
    getCurrentClinic(),
    getCurrentUserProfile(),
  ]);

  if (!rx) notFound();

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const clinicTemplate = buildA5Template(clinic, { logoUrl, headerUrl });

  const items: A5Item[] = rx.items.map((item) => ({
    type: item.type,
    name: item.name,
    dosage: item.dosage,
    form: item.form,
    frequency: item.frequency,
    duration: item.duration,
    quantity: item.quantity ?? null,
    instructions: item.instructions,
  }));

  return (
    <div>
      <div className="mb-6">
        <Link
          href={`/prescriptions/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour à l&apos;ordonnance
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">
          Modifier l&apos;ordonnance
        </h1>
      </div>
      <PrescriptionEditor
        id={id}
        clinicTemplate={clinicTemplate}
        dentistName={profile?.name ?? rx.dentistName ?? null}
        initialData={{
          patient: {
            id: rx.patient.id,
            firstName: rx.patient.firstName,
            lastName: rx.patient.lastName,
            dateOfBirth: rx.patient.dateOfBirth ?? null,
          },
          notes: rx.notes,
          items,
          rxNumber: rx.id.slice(0, 8),
        }}
      />
    </div>
  );
}