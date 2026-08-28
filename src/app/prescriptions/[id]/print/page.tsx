import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription } from "@/lib/actions/prescription";
import { getCurrentClinic } from "@/lib/actions/settings";
import { formatDate } from "@/lib/utils";
import { buildA5Template, computeAge } from "@/lib/document-branding";
import { A5Prescription } from "@/components/clinic/a5-prescription";
import type { A5Item } from "@/components/clinic/a5-prescription";
import { PrintToolbar } from "@/components/clinic/print-toolbar";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";

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

  const template = buildA5Template(clinic, { logoUrl, headerUrl });

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
        template={template}
        data={{
          rxNumber: rx.id.slice(0, 8),
          patientName: rx.patient
            ? `${rx.patient.lastName} ${rx.patient.firstName}`
            : "—",
          patientBirthdate: rx.patient?.dateOfBirth
            ? formatDate(rx.patient.dateOfBirth)
            : null,
          patientAge: rx.patient?.dateOfBirth
            ? computeAge(rx.patient.dateOfBirth)
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