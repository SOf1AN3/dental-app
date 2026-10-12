import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription, updatePrescriptionStatus } from "@/lib/actions/prescription";
import { formatDate } from "@/lib/utils";
import { PrescriptionStatusBadge } from "@/components/clinic/prescription-status-badge";
import {
  PrescriptionItemsTable,
  type PrescriptionItemTableRow,
} from "@/components/clinic/prescription-items-table";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Pencil, Printer, AlertTriangle } from "lucide-react";

export default async function PrescriptionDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const rx = await getPrescription(id);
  if (!rx) notFound();

  const items = rx.items || [];
  const patient = rx.patient;

  const isTerminal = rx.status === "completed" || rx.status === "cancelled";

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const itemRows: PrescriptionItemTableRow[] = items.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    dosage: item.dosage,
    form: item.form,
    frequency: item.frequency,
    duration: item.duration,
    quantity: item.quantity,
    instructions: item.instructions,
  }));

  return (
    <div>
      <Link
        href="/prescriptions"
        className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
      >
        ← Retour aux ordonnances
      </Link>

      <PageHeader
        title="Ordonnance"
        description={`Date: ${formatDate(rx.date)}`}
        actions={
          <>
            <PrescriptionStatusBadge status={rx.status} />
            <Link
              href={`/prescriptions/${id}/edit`}
              className="flex items-center gap-2 rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Modifier
            </Link>
            <Link
              href={`/prescriptions/${id}/print`}
              target="_blank"
              className="flex items-center gap-2 rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Printer className="h-4 w-4" aria-hidden="true" />
              Imprimer (A5)
            </Link>
          </>
        }
      />

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
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-amber-800/90 dark:text-amber-400">
              {rx.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400/90">
              Détection automatique <strong>purement textuelle</strong> et très
              imparfaite : elle compare par simple inclusion de mots les noms
              saisis aux antécédents libres du patient. Intolérances, noms de
              marque, classes thérapeutiques et fautes de frappe lui échappent,
              et de faux positifs sont possibles.{" "}
              <strong>Une absence d&apos;alerte n&apos;exclut jamais une allergie</strong>{" "}
              : ce sont les antécédents du patient qu&apos;il faut vérifier
              systématiquement.
            </p>
          </div>
        </aside>
      )}

      <div className="rounded-xl border border-border-card bg-card p-6 mb-6">
        {patient && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-muted-fg uppercase tracking-wider mb-1">
              Patient
            </p>
            <p className="font-medium text-foreground">
              {patient.lastName} {patient.firstName}
            </p>
          </div>
        )}

        {rx.notes && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-muted-fg uppercase tracking-wider mb-1">
              Notes
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap">
              {rx.notes}
            </p>
          </div>
        )}

        <PrescriptionItemsTable
          data={itemRows}
          className="rounded-lg border border-border-card bg-transparent"
        />
      </div>

      {!isTerminal && (
        <div className="flex items-center gap-3">
          {rx.status === "active" && (
            <form action={updatePrescriptionStatus.bind(null, id, "completed")}>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                Marquer complétée
              </button>
            </form>
          )}
          <form action={updatePrescriptionStatus.bind(null, id, "cancelled")}>
            <button
              type="submit"
              className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Annuler
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
