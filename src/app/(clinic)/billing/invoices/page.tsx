import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getInvoices } from "@/lib/actions/financial";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { InvoiceStatusBadge } from "@/components/clinic/invoice-status-badge";

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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Factures</h1>
          <p className="text-sm text-cool-500">
            {invoiceList.length} facture{invoiceList.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/billing/invoices/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouvelle facture
        </Link>
      </div>

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

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Numéro
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Patient
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Date
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Total
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Statut
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {invoiceList.map((invoice) => {
              const patient = patientMap.get(invoice.patientId);
              return (
                <tr
                  key={invoice.id}
                  className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-cool-900">
                    {invoice.number}
                  </td>
                  <td className="px-4 py-3 text-cool-600">
                    {patient
                      ? `${patient.lastName} ${patient.firstName}`
                      : "-"}
                  </td>
                  <td className="px-4 py-3 text-cool-600">
                    {formatDate(invoice.date)}
                  </td>
                  <td className="px-4 py-3 font-medium text-cool-900">
                    {formatCurrency(invoice.total)}
                  </td>
                  <td className="px-4 py-3">
                    <InvoiceStatusBadge status={invoice.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/billing/invoices/${invoice.id}`}
                        className="text-sm text-cerulean hover:text-cerulean/80"
                      >
                        Détails
                      </Link>
                      {invoice.status !== "paid" && invoice.status !== "cancelled" && (
                        <Link
                          href={`/billing/payments/new?invoiceId=${invoice.id}`}
                          className="text-sm text-emerald-600 hover:text-emerald-500"
                        >
                          Paiement
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {invoiceList.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-cool-400"
                >
                  Aucune facture trouvée
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
