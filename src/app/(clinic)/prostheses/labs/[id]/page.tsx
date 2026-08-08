import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getLab, getLabOrders, deleteLab } from "@/lib/actions/prosthesis";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { ProsthesisStatusBadge } from "@/components/clinic/prosthesis-status-badge";

export default async function LabDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const lab = await getLab(id);
  if (!lab) notFound();

  const orders = await getLabOrders(id);

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
          <h1 className="text-2xl font-bold text-cool-900">{lab.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/prostheses/labs/${id}/edit`}
            className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            Modifier
          </Link>
          <form action={deleteLab.bind(null, id)}>
            <button
              type="submit"
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Supprimer
            </button>
          </form>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
            <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
              Informations
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-cool-400">Personne de contact</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {lab.contactPerson || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Téléphone</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {lab.phone || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Email</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {lab.email || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-cool-400">Adresse</dt>
                <dd className="text-sm font-medium text-cool-900">
                  {lab.address || "-"}
                </dd>
              </div>
            </dl>
          </div>

          {lab.notes && (
            <div className="mt-4 rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
              <h2 className="text-sm font-medium text-cool-500 uppercase tracking-wider mb-4">
                Notes
              </h2>
              <p className="text-sm text-cool-700 whitespace-pre-wrap">{lab.notes}</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
            <div className="border-b border-cool-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-cool-900">
                Commandes ({orders.length})
              </h2>
            </div>

            {orders.length === 0 ? (
              <div className="px-6 py-12 text-center text-cool-400">
                <p className="text-sm">Aucune commande pour ce laboratoire</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-cool-200 bg-cool-50">
                      <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase">
                        N° commande
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase">
                        Patient
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase">
                        Statut
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map(({ order, patient }) => (
                      <tr
                        key={order.id}
                        className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                      >
                        <td className="px-6 py-3 font-medium text-cool-900">
                          <Link
                            href={`/prostheses/orders/${order.id}`}
                            className="text-cerulean hover:text-cerulean/80"
                          >
                            {order.orderNumber}
                          </Link>
                        </td>
                        <td className="px-6 py-3 text-cool-600">
                          {patient.lastName} {patient.firstName}
                        </td>
                        <td className="px-6 py-3">
                          <ProsthesisStatusBadge status={order.status} />
                        </td>
                        <td className="px-6 py-3 text-cool-600">
                          {formatDate(order.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
