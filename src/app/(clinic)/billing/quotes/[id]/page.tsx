import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getQuote, updateQuoteStatus } from "@/lib/actions/financial";
import { formatCurrency, formatDate } from "@/lib/utils";
import { QuoteStatusBadge } from "@/components/clinic/quote-status-badge";
import { ConvertQuoteButton } from "@/components/clinic/convert-quote-button";
import { notFound } from "next/navigation";
import Link from "next/link";
import { BackButton } from "@/components/clinic/back-button";
import { PageHeader } from "@/components/ui/page-header";
import {
  BillingItemsTable,
  type BillingItemTableRow,
} from "@/components/clinic/billing-items-table";

/**
 * Totals are read from the stored document columns (authoritative, computed
 * server-side by billing-math at creation). This mirrors the invoice detail
 * page so screen and future print views always match the database.
 */

export default async function QuoteDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const quote = await getQuote(id);
  if (!quote) notFound();

  const items = quote.items || [];
  const subtotal = quote.subtotal;
  const taxTotal = quote.taxTotal ?? 0;
  const discountTotal = quote.discountTotal ?? 0;
  const total = quote.total;

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const itemRows: BillingItemTableRow[] = items.map((item) => ({
    id: item.id,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate,
    discount: item.discount,
    total: item.total,
  }));

  return (
    <div>
      <BackButton fallback="/billing/quotes" label="← Retour aux devis" />

      <PageHeader
        title={`Devis ${quote.number}`}
        description={
          <>
            Date: {formatDate(quote.date)}
            {quote.validUntil && (
              <> · Valide jusqu&apos;au: {formatDate(quote.validUntil)}</>
            )}
          </>
        }
        actions={
          <>
            <QuoteStatusBadge status={quote.status} />
            <Link
              href={`/billing/quotes/${quote.id}/print`}
              target="_blank"
              className="rounded-lg border border-border-input bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Imprimer
            </Link>
            <p className="text-2xl font-bold text-foreground">
              {formatCurrency(total)}
            </p>
          </>
        }
      />

      <div className="rounded-xl border border-border-card bg-card p-6 mb-6">
        {quote.patient && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-muted-fg uppercase tracking-wider mb-1">
              Patient
            </p>
            <p className="font-medium text-foreground">
              {quote.patient.lastName} {quote.patient.firstName}
            </p>
          </div>
        )}

        {quote.notes && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-muted-fg uppercase tracking-wider mb-1">
              Notes
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap">
              {quote.notes}
            </p>
          </div>
        )}

        <BillingItemsTable
          data={itemRows}
          emptyTitle="Aucun article dans ce devis"
          className="rounded-lg border border-border-card bg-transparent"
        />

        <div className="mt-4 space-y-1 text-sm border-t border-border-card pt-4">
          <div className="flex justify-between text-muted-fg">
            <span>Sous-total</span>
            <span>{formatCurrency(subtotal)}</span>
          </div>
          {taxTotal > 0 && (
            <div className="flex justify-between text-muted-fg">
              <span>Total TVA</span>
              <span>{formatCurrency(taxTotal)}</span>
            </div>
          )}
          {discountTotal > 0 && (
            <div className="flex justify-between text-muted-fg">
              <span>Total remises</span>
              <span>-{formatCurrency(discountTotal)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-foreground text-base pt-2 border-t border-border-card">
            <span>Total</span>
            <span>{formatCurrency(total)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {quote.status === "draft" && (
          <form
            action={updateQuoteStatus.bind(null, id, "sent")}
          >
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              Envoyer
            </button>
          </form>
        )}
        {quote.status === "sent" && (
          <>
            <form action={updateQuoteStatus.bind(null, id, "accepted")}>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                Accepter
              </button>
            </form>
            <form action={updateQuoteStatus.bind(null, id, "rejected")}>
              <button
                type="submit"
                className="rounded-lg border border-border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Refuser
              </button>
            </form>
          </>
        )}
        {quote.status === "accepted" && !quote.convertedInvoiceId && (
          <ConvertQuoteButton quoteId={quote.id} />
        )}
        {quote.convertedInvoiceId && (
          <Link
            href={`/billing/invoices/${quote.convertedInvoiceId}`}
            className="rounded-lg border border-cerulean px-4 py-2 text-sm font-medium text-cerulean hover:bg-cerulean/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Voir la facture liée
          </Link>
        )}
        <BackButton
          fallback="/billing/quotes"
          label="Retour à la liste"
        />
      </div>
    </div>
  );
}
