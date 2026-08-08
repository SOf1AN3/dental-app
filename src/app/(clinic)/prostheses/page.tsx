import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOrders, getLabs } from "@/lib/actions/prosthesis";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { ProsthesisStatusBadge } from "@/components/clinic/prosthesis-status-badge";

export default async function ProsthesesPage() {
  await requireAuth();
  await getCurrentClinicId();

  const orders = await getOrders();
  const labs = await getLabs();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Prothèses</h1>
          <p className="text-sm text-cool-500">
            {orders.length} commandes &middot; {labs.length} laboratoires
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/prostheses/labs/new"
            className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            + Nouveau laboratoire
          </Link>
          <Link
            href="/prostheses/orders/new"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
          >
            + Nouvelle commande
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <div className="border-b border-cool-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-cool-900">Commandes</h2>
        </div>

        {orders.length === 0 ? (
          <div className="px-6 py-12 text-center text-cool-400">
            <p className="text-lg mb-1">Aucune commande</p>
            <p className="text-sm">
              Commencez par{" "}
              <Link href="/prostheses/orders/new" className="text-cerulean hover:text-cerulean/80">
                créer une nouvelle commande
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 bg-cool-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    N° commande
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Patient
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Labo
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Statut
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Date livraison
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map(({ order, patient, lab }) => (
                  <tr
                    key={order.id}
                    className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                  >
                    <td className="px-6 py-3 font-medium text-cool-900">
                      {order.orderNumber}
                    </td>
                    <td className="px-6 py-3">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="text-cerulean hover:text-cerulean/80"
                      >
                        {patient.lastName} {patient.firstName}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-cool-600 max-w-xs truncate">
                      {order.description}
                    </td>
                    <td className="px-6 py-3 text-cool-600">
                      {lab?.name || "-"}
                    </td>
                    <td className="px-6 py-3">
                      <ProsthesisStatusBadge status={order.status} />
                    </td>
                    <td className="px-6 py-3 text-cool-600">
                      {order.deliveryDate ? formatDate(order.deliveryDate) : "-"}
                    </td>
                    <td className="px-6 py-3">
                      <Link
                        href={`/prostheses/orders/${order.id}`}
                        className="text-sm text-cerulean hover:text-cerulean/80"
                      >
                        Détails
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <div className="border-b border-cool-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-cool-900">Laboratoires</h2>
        </div>

        {labs.length === 0 ? (
          <div className="px-6 py-12 text-center text-cool-400">
            <p className="text-lg mb-1">Aucun laboratoire</p>
            <p className="text-sm">
              Ajoutez un{" "}
              <Link href="/prostheses/labs/new" className="text-cerulean hover:text-cerulean/80">
                nouveau laboratoire
              </Link>{" "}
              pour commencer.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 bg-cool-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Nom
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Contact
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Téléphone
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {labs.map((lab) => (
                  <tr
                    key={lab.id}
                    className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                  >
                    <td className="px-6 py-3 font-medium text-cool-900">
                      <Link
                        href={`/prostheses/labs/${lab.id}`}
                        className="text-cerulean hover:text-cerulean/80"
                      >
                        {lab.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-cool-600">
                      {lab.contactPerson || "-"}
                    </td>
                    <td className="px-6 py-3 text-cool-600">
                      {lab.phone || "-"}
                    </td>
                    <td className="px-6 py-3 text-cool-600">
                      {lab.email || "-"}
                    </td>
                    <td className="px-6 py-3">
                      <Link
                        href={`/prostheses/labs/${lab.id}`}
                        className="text-sm text-cerulean hover:text-cerulean/80"
                      >
                        Détails
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
