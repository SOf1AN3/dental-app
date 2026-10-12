import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOrder, updateOrderStatus } from "@/lib/actions/prosthesis";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { ProsthesisStatusBadge } from "@/components/clinic/prosthesis-status-badge";

export default async function OrderDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const result = await getOrder(id);
  if (!result) notFound();

  const { order, patient, lab } = result;

  const nextStatus = order.status === "ordered"
    ? { status: "in_progress", label: "Marquer en cours" }
    : order.status === "in_progress"
      ? { status: "delivered", label: "Marquer livrée" }
      : null;

  return (
    <div>
      <Link
        href="/prostheses"
        className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
      >
        &larr; Retour aux prothèses
      </Link>
      <PageHeader
        title={`Commande ${order.orderNumber}`}
        actions={
          <>
            {order.status !== "delivered" && order.status !== "cancelled" && nextStatus && (
              <form action={updateOrderStatus.bind(null, id, nextStatus.status)}>
                <button
                  type="submit"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
                >
                  {nextStatus.label}
                </button>
              </form>
            )}
            {order.status !== "cancelled" && order.status !== "delivered" && (
              <form action={updateOrderStatus.bind(null, id, "cancelled")}>
                <button
                  type="submit"
                  className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  Annuler
                </button>
              </form>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Détails de la commande
            </h2>
            <dl className="grid grid-cols-2 gap-y-4 gap-x-6">
              <div>
                <dt className="text-xs text-muted-fg">Statut</dt>
                <dd className="mt-0.5">
                  <ProsthesisStatusBadge status={order.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Date de commande</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {formatDate(order.createdAt)}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-fg">Description</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.description}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">N° dent</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.toothNumber ?? "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Matériau</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.material || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Couleur</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.color || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Date de livraison</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.deliveryDate ? formatDate(order.deliveryDate) : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Coût</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {order.cost ? formatCurrency(order.cost) : "-"}
                </dd>
              </div>
            </dl>
          </div>

          {order.notes && (
            <div className="rounded-xl border border-border-card bg-card p-6">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
                Notes
              </h2>
              <p className="text-sm text-foreground whitespace-pre-wrap">{order.notes}</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Patient
            </h2>
            <p className="text-lg font-semibold text-foreground">
              {patient.lastName} {patient.firstName}
            </p>
            {patient.phone && (
              <p className="mt-1 text-sm text-muted-fg">{patient.phone}</p>
            )}
            <Link
              href={`/patients/${patient.id}`}
              className="mt-3 inline-block text-sm text-cerulean hover:text-cerulean/80"
            >
              Voir le dossier &rarr;
            </Link>
          </div>

          {lab && (
            <div className="rounded-xl border border-border-card bg-card p-6">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
                Laboratoire
              </h2>
              <p className="text-lg font-semibold text-foreground">{lab.name}</p>
              {lab.phone && (
                <p className="mt-1 text-sm text-muted-fg">{lab.phone}</p>
              )}
              {lab.email && (
                <p className="text-sm text-muted-fg">{lab.email}</p>
              )}
              <Link
                href={`/prostheses/labs/${lab.id}`}
                className="mt-3 inline-block text-sm text-cerulean hover:text-cerulean/80"
              >
                Voir le laboratoire &rarr;
              </Link>
            </div>
          )}

          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Dernière mise à jour
            </h2>
            <p className="text-sm text-foreground">
              {formatDate(order.updatedAt)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
