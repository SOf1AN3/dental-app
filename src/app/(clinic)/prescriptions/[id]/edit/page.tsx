import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription } from "@/lib/actions/prescription";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { PrescriptionEditor } from "@/components/clinic/prescription-editor";
import type { A5Template, A5Item } from "@/components/clinic/a5-prescription";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";
import Link from "next/link";

const FALLBACK_TEMPLATE: A5Template = {
  name: "Cabinet Dentaire",
  address: null,
  phone: null,
  email: null,
  legalInfo: null,
  logoUrl: null,
  headerUrl: null,
  watermarkEnabled: false,
};

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

  const clinicTemplate: A5Template = clinic
    ? {
        name: clinic.name,
        address: clinic.address,
        phone: clinic.phone,
        email: clinic.email,
        legalInfo: clinic.legalInfo,
        logoUrl,
        headerUrl,
        watermarkEnabled: clinic.watermarkEnabled,
      }
    : FALLBACK_TEMPLATE;

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
