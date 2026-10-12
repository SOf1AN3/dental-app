import { Plus } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getOrders, getLabs } from "@/lib/actions/prosthesis";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
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
      <PageHeader
        title="Prothèses"
        description={`${orders.length} commandes · ${labs.length} laboratoires`}
        actions={
          <>
            <Link
              href="/prostheses/labs/new"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouveau laboratoire
            </Link>
            <Link
              href="/prostheses/orders/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouvelle commande
            </Link>
          </>
        }
      />

      <div className="rounded-xl border border-border-card bg-card">
        <div className="border-b border-border-card px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">Commandes</h2>
        </div>

        <ProsthesisTable
          data={orderRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>

      <div className="mt-8 rounded-xl border border-border-card bg-card">
        <div className="border-b border-border-card px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">Laboratoires</h2>
        </div>

        <ProsthesisLabTable
          data={labRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>
    </div>
  );
}
