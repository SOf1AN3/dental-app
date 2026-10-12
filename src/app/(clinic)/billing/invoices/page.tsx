import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getInvoices } from "@/lib/actions/financial";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { FilePlus2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import {
  InvoiceTable,
  type InvoiceTableRow,
} from "@/components/clinic/invoice-table";

const statusTabs = [
  { label: "Toutes", value: "" },
  { label: "Brouillon", value: "draft" },
  { label: "Envoyée", value: "sent" },
  { label: "Payée", value: "paid" },
  { label: "Partielle", value: "partially_paid" },
  { label: "Impayée", value: "overdue" },
  { label: "Annulée", value: "cancelled" },
];

export default async function InvoicesPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const searchParams = await props.searchParams;
  const currentStatus = searchParams.status || "";

  const invoiceList = await getInvoices(currentStatus || undefined);

  const patientIds = [...new Set(invoiceList.map((i) => i.patientId))];
  const patientRows = patientIds.length
    ? await db
        .select({
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
        })
        .from(patients)
        .where(eq(patients.clinicId, clinicId))
    : [];

  const patientMap = new Map(patientRows.map((p) => [p.id, p]));

  // Données PLATES uniquement : le tableau est un Client Component, aucune
  // fonction ni composant ne doit traverser la frontière serveur/client.
  const rows: InvoiceTableRow[] = invoiceList.map((invoice) => {
    const patient = patientMap.get(invoice.patientId);
    return {
      id: invoice.id,
      number: invoice.number,
      date: invoice.date,
      dueDate: invoice.dueDate,
      status: invoice.status,
      total: invoice.total,
      patientFirstName: patient?.firstName ?? null,
      patientLastName: patient?.lastName ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        title="Factures"
        description={`${invoiceList.length} facture${invoiceList.length !== 1 ? "s" : ""}`}
        actions={
          <Link
            href="/billing/invoices/new"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
            Nouvelle facture
          </Link>
        }
      />

      <div className="flex items-center gap-1 mb-4 overflow-x-auto">
        {statusTabs.map((tab) => {
          const href = tab.value
            ? `/billing/invoices?status=${tab.value}`
            : "/billing/invoices";
          const isActive = currentStatus === tab.value;
          return (
            <Link
              key={tab.value}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? "bg-primary text-white"
                  : "bg-cool-100 text-cool-600 hover:bg-cool-200"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <InvoiceTable data={rows} />
    </div>
  );
}
