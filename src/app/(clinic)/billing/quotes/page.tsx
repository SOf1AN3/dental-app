import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getQuotes } from "@/lib/actions/financial";
import Link from "next/link";
import { FileSignature } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { QuoteTable, type QuoteTableRow } from "@/components/clinic/quote-table";

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

  // Données PLATES uniquement : le tableau est un Client Component, aucune
  // fonction ni composant ne doit traverser la frontière serveur/client.
  const rows: QuoteTableRow[] = quoteList.map((quote) => ({
    id: quote.id,
    number: quote.number,
    date: quote.date,
    validUntil: quote.validUntil,
    status: quote.status,
    total: quote.total,
    patientFirstName: quote.patient?.firstName ?? null,
    patientLastName: quote.patient?.lastName ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="Devis"
        description={`${quoteList.length} devis`}
        actions={
          <Link
            href="/billing/quotes/new"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FileSignature className="h-4 w-4" aria-hidden="true" />
            Nouveau devis
          </Link>
        }
      />

      <div className="flex items-center gap-1 mb-4">
        {statusTabs.map((tab) => {
          const href = tab.value
            ? `/billing/quotes?status=${tab.value}`
            : "/billing/quotes";
          const isActive = activeStatus === tab.value;
          return (
            <Link
              key={tab.value}
              href={href}
              aria-current={isActive ? "page" : undefined}
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

      <QuoteTable data={rows} />
    </div>
  );
}
