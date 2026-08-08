import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import {
  getInvoices,
  getQuotes,
  getInvoicesSummary,
} from "@/lib/actions/financial";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { InvoiceStatusBadge } from "@/components/clinic/invoice-status-badge";

export default async function BillingPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const [summary, invoiceList, quoteList] = await Promise.all([
    getInvoicesSummary(),
    getInvoices(),
    getQuotes(),
  ]);

  const recentInvoices = invoiceList.slice(0, 5);
  const recentQuotes = quoteList.slice(0, 5);

  const patientMap = new Map<
    string,
    { firstName: string; lastName: string }
  >();

  const allPatientIds = [
    ...recentInvoices.map((i) => i.patientId),
    ...recentQuotes.map((q) => q.patientId),
  ];

  if (allPatientIds.length > 0) {
    const patientRows = await db
      .select({
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
      })
      .from(patients)
      .where(eq(patients.clinicId, clinicId));

    for (const p of patientRows) {
      patientMap.set(p.id, p);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Facturation</h1>
          <p className="text-sm text-cool-500">
            Gérez les factures, devis et paiements
          </p>
        </div>
        <Link
          href="/billing/invoices/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouvelle facture
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-5">
          <p className="text-sm text-cool-500">Total factures</p>
          <p className="text-2xl font-bold text-cool-900 mt-1">
            {summary.totalCount}
          </p>
        </div>
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-5">
          <p className="text-sm text-cool-500">Montant total</p>
          <p className="text-2xl font-bold text-cool-900 mt-1">
            {formatCurrency(summary.totalAmount)}
          </p>
        </div>
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-5">
          <p className="text-sm text-cool-500">En attente de paiement</p>
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">
            {formatCurrency(summary.pendingAmount)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
          <div className="flex items-center justify-between px-6 py-4 border-b border-cool-200">
            <h2 className="text-base font-semibold text-cool-900">
              Factures récentes
            </h2>
            <Link
              href="/billing/invoices"
              className="text-sm text-cerulean hover:text-cerulean/80"
            >
              Voir tout
            </Link>
          </div>
          <div>
            {recentInvoices.length === 0 ? (
              <p className="px-6 py-8 text-sm text-cool-400 text-center">
                Aucune facture
              </p>
            ) : (
              recentInvoices.map((invoice) => {
                const patient = patientMap.get(invoice.patientId);
                return (
                  <Link
                    key={invoice.id}
                    href={`/billing/invoices/${invoice.id}`}
                    className="flex items-center justify-between px-6 py-3 hover:bg-cool-50 transition-colors border-b border-cool-100 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-cool-900">
                        {invoice.number}
                      </p>
                      <p className="text-xs text-cool-500">
                        {patient
                          ? `${patient.lastName} ${patient.firstName}`
                          : "Patient inconnu"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-cool-900">
                        {formatCurrency(invoice.total)}
                      </p>
                      <InvoiceStatusBadge status={invoice.status} />
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
          <div className="flex items-center justify-between px-6 py-4 border-b border-cool-200">
            <h2 className="text-base font-semibold text-cool-900">
              Devis récents
            </h2>
            <Link
              href="/billing/quotes"
              className="text-sm text-cerulean hover:text-cerulean/80"
            >
              Voir tout
            </Link>
          </div>
          <div>
            {recentQuotes.length === 0 ? (
              <p className="px-6 py-8 text-sm text-cool-400 text-center">
                Aucun devis
              </p>
            ) : (
              recentQuotes.map((quote) => {
                const patient = patientMap.get(quote.patientId);
                return (
                  <Link
                    key={quote.id}
                    href={`/billing/quotes/${quote.id}`}
                    className="flex items-center justify-between px-6 py-3 hover:bg-cool-50 transition-colors border-b border-cool-100 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-cool-900">
                        {quote.number}
                      </p>
                      <p className="text-xs text-cool-500">
                        {patient
                          ? `${patient.lastName} ${patient.firstName}`
                          : "Patient inconnu"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-cool-900">
                        {formatCurrency(quote.total)}
                      </p>
                      <p className="text-xs text-cool-500">
                        {formatDate(quote.date)}
                      </p>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
