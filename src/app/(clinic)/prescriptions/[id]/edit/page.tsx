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
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

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
      <Link
        href={`/prescriptions/${id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
      >
        ← Retour à l&apos;ordonnance
      </Link>
      <PageHeader title="Modifier l'ordonnance" />
      {rx.warnings.length > 0 && (
        <aside
          aria-label="Alerte d'allergie possible"
          className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
              Allergie possible — vérification manuelle requise
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400/90">
              Détection automatique <strong>purement textuelle</strong> et très
              imparfaite : elle compare par simple inclusion de mots les noms
              saisis aux antécédents libres du patient. Intolérances, noms de
              marque, classes thérapeutiques et fautes de frappe lui échappent,
              et de faux positifs sont possibles.{" "}
              <strong>Une absence d&apos;alerte n&apos;exclut jamais une allergie</strong>{" "}
              : ce sont les antécédents du patient qu&apos;il faut vérifier
              systématiquement.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-amber-800/90 dark:text-amber-400">
              {rx.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </aside>
      )}
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