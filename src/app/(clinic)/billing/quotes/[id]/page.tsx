import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getQuote, updateQuoteStatus } from "@/lib/actions/financial";
import { formatCurrency, formatDate } from "@/lib/utils";
import { QuoteStatusBadge } from "@/components/clinic/quote-status-badge";
import { ConvertQuoteButton } from "@/components/clinic/convert-quote-button";
import { notFound } from "next/navigation";
import Link from "next/link";
import { BackButton } from "@/components/clinic/back-button";

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

  return (
    <div>
      <div className="mb-6">
        <BackButton fallback="/billing/quotes" label="← Retour aux devis" />
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 mb-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-cool-900">
                Devis {quote.number}
              </h1>
              <QuoteStatusBadge status={quote.status} />
              <Link
                href={`/billing/quotes/${quote.id}/print`}
                target="_blank"
                className="rounded-lg border border-cool-200 px-3 py-1.5 text-xs font-medium text-cool-600 hover:bg-cool-50 transition-colors"
              >
                Imprimer
              </Link>
            </div>
            <p className="text-sm text-cool-500">
              Date: {formatDate(quote.date)}
              {quote.validUntil && (
                <> · Valide jusqu&apos;au: {formatDate(quote.validUntil)}</>
              )}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-cool-900">
              {formatCurrency(total)}
            </p>
          </div>
        </div>

        {quote.patient && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-cool-400 uppercase tracking-wider mb-1">
              Patient
            </p>
            <p className="font-medium text-cool-900">
              {quote.patient.lastName} {quote.patient.firstName}
            </p>
          </div>
        )}

        {quote.notes && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-cool-400 uppercase tracking-wider mb-1">
              Notes
            </p>
            <p className="text-sm text-cool-700 whitespace-pre-wrap">
              {quote.notes}
            </p>
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-cool-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 bg-cool-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Qté
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Prix unitaire
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                    TVA
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Remise
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  return (
                    <tr
                      key={item.id}
                      className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                    >
                      <td className="px-4 py-3 text-cool-900">
                        {item.description}
                      </td>
                      <td className="px-4 py-3 text-right text-cool-600">
                        {item.quantity}
                      </td>
                      <td className="px-4 py-3 text-right text-cool-600">
                        {formatCurrency(item.unitPrice)}
                      </td>
                      <td className="px-4 py-3 text-right text-cool-600">
                        {(item.taxRate ?? 0) > 0 ? `${item.taxRate}%` : "-"}
                      </td>
                      <td className="px-4 py-3 text-right text-cool-600">
                        {(item.discount ?? 0) > 0 ? formatCurrency(item.discount ?? 0) : "-"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-cool-900">
                        {formatCurrency(item.total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 space-y-1 text-sm border-t border-cool-200 pt-4">
          <div className="flex justify-between text-cool-500">
            <span>Sous-total</span>
            <span>{formatCurrency(subtotal)}</span>
          </div>
          {taxTotal > 0 && (
            <div className="flex justify-between text-cool-500">
              <span>Total TVA</span>
              <span>{formatCurrency(taxTotal)}</span>
            </div>
          )}
          {discountTotal > 0 && (
            <div className="flex justify-between text-cool-500">
              <span>Total remises</span>
              <span>-{formatCurrency(discountTotal)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-cool-900 text-base pt-2 border-t border-cool-200">
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
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
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
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
              >
                Accepter
              </button>
            </form>
            <form action={updateQuoteStatus.bind(null, id, "rejected")}>
              <button
                type="submit"
                className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
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
            className="rounded-lg border border-cerulean px-4 py-2 text-sm font-medium text-cerulean hover:bg-cerulean/5 transition-colors"
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
