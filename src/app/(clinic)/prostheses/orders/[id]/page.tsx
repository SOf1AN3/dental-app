import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOrder, updateOrderStatus } from "@/lib/actions/prosthesis";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate, formatCurrency } from "@/lib/utils";
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
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href="/prostheses"
            className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
          >
            &larr; Retour aux prothèses
          </Link>
          <h1 className="text-2xl font-bold text-cool-900">
            Commande {order.orderNumber}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {order.status !== "delivered" && order.status !== "cancelled" && nextStatus && (
            <form action={updateOrderStatus.bind(null, id, nextStatus.status)}>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
              >
                {nextStatus.label}
              </button>
            </form>
          )}
          {order.status !== "cancelled" && order.status !== "delivered" && (
            <form action={updateOrderStatus.bind(null, id, "cancelled")}>
              <button
                type="submit"
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                Annuler
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl border border-cool-200 bg-white p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Détails de la commande
            </h2>
            <dl className="grid grid-cols-2 gap-y-4 gap-x-6">
              <div>
                <dt className="text-xs text-cool-400">Statut</dt>
                <dd className="mt-0.5">
                  <ProsthesisStatusBadge status={order.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Date de commande</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {formatDate(order.createdAt)}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-cool-400">Description</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.description}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">N° dent</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.toothNumber ?? "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Matériau</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.material || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Couleur</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.color || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Date de livraison</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.deliveryDate ? formatDate(order.deliveryDate) : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Coût</dt>
                <dd className="mt-0.5 text-sm font-medium text-cool-900">
                  {order.cost ? formatCurrency(order.cost) : "-"}
                </dd>
              </div>
            </dl>
          </div>

          {order.notes && (
            <div className="rounded-xl border border-cool-200 bg-white p-6">
              <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
                Notes
              </h2>
              <p className="text-sm text-cool-700 whitespace-pre-wrap">{order.notes}</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-cool-200 bg-white p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Patient
            </h2>
            <p className="text-lg font-semibold text-cool-900">
              {patient.lastName} {patient.firstName}
            </p>
            {patient.phone && (
              <p className="mt-1 text-sm text-cool-500">{patient.phone}</p>
            )}
            <Link
              href={`/patients/${patient.id}`}
              className="mt-3 inline-block text-sm text-cerulean hover:text-cerulean/80"
            >
              Voir le dossier &rarr;
            </Link>
          </div>

          {lab && (
            <div className="rounded-xl border border-cool-200 bg-white p-6">
              <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
                Laboratoire
              </h2>
              <p className="text-lg font-semibold text-cool-900">{lab.name}</p>
              {lab.phone && (
                <p className="mt-1 text-sm text-cool-500">{lab.phone}</p>
              )}
              {lab.email && (
                <p className="text-sm text-cool-500">{lab.email}</p>
              )}
              <Link
                href={`/prostheses/labs/${lab.id}`}
                className="mt-3 inline-block text-sm text-cerulean hover:text-cerulean/80"
              >
                Voir le laboratoire &rarr;
              </Link>
            </div>
          )}

          <div className="rounded-xl border border-cool-200 bg-white p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Dernière mise à jour
            </h2>
            <p className="text-sm text-cool-700">
              {formatDate(order.updatedAt)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
