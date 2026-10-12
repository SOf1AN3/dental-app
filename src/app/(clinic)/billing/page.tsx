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
import { FilePlus2, FileSignature, HandCoins } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
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
      <PageHeader
        title="Facturation"
        description="Gérez les factures, devis et paiements"
        actions={
          <>
            <Link
              href="/billing/payments/new"
              className="inline-flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <HandCoins className="h-4 w-4" aria-hidden="true" />
              Enregistrer un paiement
            </Link>
            <Link
              href="/billing/quotes/new"
              className="inline-flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <FileSignature className="h-4 w-4" aria-hidden="true" />
              Nouveau devis
            </Link>
            <Link
              href="/billing/invoices/new"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <FilePlus2 className="h-4 w-4" aria-hidden="true" />
              Nouvelle facture
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="rounded-xl border border-border-card bg-card p-5">
          <p className="text-sm text-muted-fg">Total factures</p>
          <p className="text-2xl font-bold text-foreground mt-1">
            {summary.totalCount}
          </p>
        </div>
        <div className="rounded-xl border border-border-card bg-card p-5">
          <p className="text-sm text-muted-fg">Montant total</p>
          <p className="text-2xl font-bold text-foreground mt-1">
            {formatCurrency(summary.totalAmount)}
          </p>
        </div>
        <div className="rounded-xl border border-border-card bg-card p-5">
          <p className="text-sm text-muted-fg">En attente de paiement</p>
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">
            {formatCurrency(summary.pendingAmount)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-border-card bg-card">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-card">
            <h2 className="text-base font-semibold text-foreground">
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
              <p className="px-6 py-8 text-sm text-muted-fg text-center">
                Aucune facture
              </p>
            ) : (
              recentInvoices.map((invoice) => {
                const patient = patientMap.get(invoice.patientId);
                return (
                  <Link
                    key={invoice.id}
                    href={`/billing/invoices/${invoice.id}`}
                    className="flex items-center justify-between px-6 py-3 hover:bg-cool-50 transition-colors border-b border-border-card/60 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {invoice.number}
                      </p>
                      <p className="text-xs text-muted-fg">
                        {patient
                          ? `${patient.lastName} ${patient.firstName}`
                          : "Patient inconnu"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-foreground">
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

        <div className="rounded-xl border border-border-card bg-card">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-card">
            <h2 className="text-base font-semibold text-foreground">
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
              <p className="px-6 py-8 text-sm text-muted-fg text-center">
                Aucun devis
              </p>
            ) : (
              recentQuotes.map((quote) => {
                const patient = patientMap.get(quote.patientId);
                return (
                  <Link
                    key={quote.id}
                    href={`/billing/quotes/${quote.id}`}
                    className="flex items-center justify-between px-6 py-3 hover:bg-cool-50 transition-colors border-b border-border-card/60 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {quote.number}
                      </p>
                      <p className="text-xs text-muted-fg">
                        {patient
                          ? `${patient.lastName} ${patient.firstName}`
                          : "Patient inconnu"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-foreground">
                        {formatCurrency(quote.total)}
                      </p>
                      <p className="text-xs text-muted-fg">
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
