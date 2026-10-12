import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getLab, getLabOrders, deleteLab } from "@/lib/actions/prosthesis";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { LabOrdersTable, type LabOrderTableRow } from "@/components/clinic/lab-orders-table";

export default async function LabDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirm?: string; error?: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;
  const search = await props.searchParams;

  const lab = await getLab(id);
  if (!lab) notFound();

  const orders = await getLabOrders(id);

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const orderRows: LabOrderTableRow[] = orders.map(({ order, patient }) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    patientFirstName: patient.firstName,
    patientLastName: patient.lastName,
    status: order.status,
    createdAt: order.createdAt,
  }));

  // Z-50 : étape de confirmation avant suppression (le laboratoire peut être
  // rattaché à des commandes que la suppression détacherait).
  const confirming = search.confirm === "1";
  // Z-50 : message de refus éventuel transmis par `deleteLab` (redirection
  // retour) — affiché tel quel, React l'échappe.
  const deleteError = typeof search.error === "string" ? search.error : null;

  return (
    <div>
      <Link
        href="/prostheses"
        className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
      >
        &larr; Retour aux prothèses
      </Link>
      <PageHeader
        title={lab.name}
        actions={
          <>
            <Link
              href={`/prostheses/labs/${id}/edit`}
              className="rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Modifier
            </Link>
            <Link
              href={`/prostheses/labs/${id}?confirm=1`}
              className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Supprimer
            </Link>
          </>
        }
      />

      {deleteError && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {deleteError}
        </div>
      )}

      {confirming && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
          <div className="flex items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
                Confirmer la suppression du laboratoire « {lab.name} » ?
              </p>
              <p className="mt-1 text-sm text-amber-800/90 dark:text-amber-400">
                {orders.length > 0
                  ? `${orders.length} commande(s) sont rattachées à ce laboratoire : sa suppression les détachera (elles perdront leur laboratoire).`
                  : "Aucune commande n'est rattachée à ce laboratoire."}{" "}
                Cette action est irréversible.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <form action={deleteLab.bind(null, id)}>
              {/* Z-50 : confirmation explicite exigée par `deleteLab` pour un
                  laboratoire rattaché à des commandes. */}
              <input type="hidden" name="confirm" value="true" />
              <button
                type="submit"
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-white hover:bg-destructive/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                Confirmer la suppression
              </button>
            </form>
            <Link
              href={`/prostheses/labs/${id}`}
              className="rounded-lg border border-border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Annuler
            </Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Informations
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-muted-fg">Personne de contact</dt>
                <dd className="text-sm font-medium text-foreground">
                  {lab.contactPerson || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Téléphone</dt>
                <dd className="text-sm font-medium text-foreground">
                  {lab.phone || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Email</dt>
                <dd className="text-sm font-medium text-foreground">
                  {lab.email || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Adresse</dt>
                <dd className="text-sm font-medium text-foreground">
                  {lab.address || "-"}
                </dd>
              </div>
            </dl>
          </div>

          {lab.notes && (
            <div className="mt-4 rounded-xl border border-border-card bg-card p-6">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
                Notes
              </h2>
              <p className="text-sm text-foreground whitespace-pre-wrap">{lab.notes}</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border-card bg-card">
            <div className="border-b border-border-card px-6 py-4">
              <h2 className="text-lg font-semibold text-foreground">
                Commandes ({orders.length})
              </h2>
            </div>

            <LabOrdersTable
              data={orderRows}
              className="rounded-none border-0 bg-transparent"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
