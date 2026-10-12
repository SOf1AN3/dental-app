import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOrders, getLabs } from "@/lib/actions/prosthesis";
import Link from "next/link";
import {
  ProsthesisTable,
  ProsthesisLabTable,
  type ProsthesisTableRow,
  type ProsthesisLabTableRow,
} from "@/components/clinic/prosthesis-table";

export default async function ProsthesesPage() {
  await requireAuth();
  await getCurrentClinicId();

  const orders = await getOrders();
  const labs = await getLabs();

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const orderRows: ProsthesisTableRow[] = orders.map(({ order, patient, lab }) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    description: order.description,
    status: order.status,
    deliveryDate: order.deliveryDate,
    patientId: patient.id,
    patientFirstName: patient.firstName,
    patientLastName: patient.lastName,
    labName: lab?.name ?? null,
  }));

  const labRows: ProsthesisLabTableRow[] = labs.map((lab) => ({
    id: lab.id,
    name: lab.name,
    contactPerson: lab.contactPerson,
    phone: lab.phone,
    email: lab.email,
  }));

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

        <ProsthesisTable
          data={orderRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>

      <div className="mt-8 rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <div className="border-b border-cool-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-cool-900">Laboratoires</h2>
        </div>

        <ProsthesisLabTable
          data={labRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>
    </div>
  );
}
