import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription } from "@/lib/actions/prescription";
import { getCurrentClinic } from "@/lib/actions/settings";
import { formatDate } from "@/lib/utils";
import { A5Prescription } from "@/components/clinic/a5-prescription";
import type { A5Template, A5Item } from "@/components/clinic/a5-prescription";
import { PrintToolbar } from "@/components/clinic/print-toolbar";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";

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

export default async function PrescriptionPrintPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const [rx, clinic] = await Promise.all([
    getPrescription(id),
    getCurrentClinic(),
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
    <>
      <PrintToolbar />
      <A5Prescription
        template={clinicTemplate}
        data={{
          rxNumber: rx.id.slice(0, 8),
          patientName: rx.patient
            ? `${rx.patient.lastName} ${rx.patient.firstName}`
            : "—",
          patientBirthdate: rx.patient?.dateOfBirth
            ? formatDate(rx.patient.dateOfBirth)
            : null,
          dentistName: rx.dentistName,
          date: formatDate(rx.date),
          notes: rx.notes,
          items,
        }}
      />
    </>
  );
}
