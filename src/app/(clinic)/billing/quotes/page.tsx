import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getQuotes } from "@/lib/actions/financial";
import { formatCurrency, formatDate } from "@/lib/utils";
import { QuoteStatusBadge } from "@/components/clinic/quote-status-badge";
import Link from "next/link";

const statusTabs = [
  { label: "Toutes", value: "" },
  { label: "Brouillon", value: "draft" },
  { label: "Envoyé", value: "sent" },
  { label: "Accepté", value: "accepted" },
  { label: "Refusé", value: "rejected" },
  { label: "Expiré", value: "expired" },
];

export default async function QuotesPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const searchParams = await props.searchParams;
  const activeStatus = searchParams.status || "";

  const quoteList = await getQuotes(activeStatus || undefined);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Devis</h1>
          <p className="text-sm text-cool-500">{quoteList.length} devis</p>
        </div>
        <Link
          href="/billing/quotes/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouveau devis
        </Link>
      </div>

      <div className="flex items-center gap-1 mb-4">
        {statusTabs.map((tab) => {
          const href = tab.value ? `/billing/quotes?status=${tab.value}` : "/billing/quotes";
          const isActive = activeStatus === tab.value;
          return (
            <Link
              key={tab.value}
              href={href}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-white"
                  : "text-cool-500 hover:bg-cool-100"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
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
                Validité
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
            {quoteList.map((quote) => (
              <tr
                key={quote.id}
                className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
              >
                <td className="px-4 py-3 font-medium text-cool-900">
                  <Link
                    href={`/billing/quotes/${quote.id}`}
                    className="text-cerulean hover:text-cerulean/80"
                  >
                    {quote.number}
                  </Link>
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {quote.patient
                    ? `${quote.patient.lastName} ${quote.patient.firstName}`
                    : "-"}
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {formatDate(quote.date)}
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {quote.validUntil ? formatDate(quote.validUntil) : "-"}
                </td>
                <td className="px-4 py-3 font-medium text-cool-900">
                  {formatCurrency(quote.total)}
                </td>
                <td className="px-4 py-3">
                  <QuoteStatusBadge status={quote.status} />
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/billing/quotes/${quote.id}`}
                    className="text-sm text-cerulean hover:text-cerulean/80"
                  >
                    Détails
                  </Link>
                </td>
              </tr>
            ))}
            {quoteList.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-cool-400">
                  Aucun devis trouvé
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
