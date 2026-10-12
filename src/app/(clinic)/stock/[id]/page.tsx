import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getStockItem } from "@/lib/actions/inventory";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { StockStatusBadge } from "@/components/clinic/stock-status-badge";
import { StockTransactionForm } from "@/components/clinic/stock-transaction-form";
import {
  StockTransactionsTable,
  type StockTransactionTableRow,
} from "@/components/clinic/stock-transactions-table";

export default async function StockItemDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tx?: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;
  const { tx } = await props.searchParams;

  const item = await getStockItem(id);

  if (!item) {
    notFound();
  }

  const defaultType = tx === "in" || tx === "out" ? tx : undefined;

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const transactionRows: StockTransactionTableRow[] = item.transactions.map(
    (transaction) => ({
      id: transaction.id,
      type: transaction.type,
      qty: transaction.qty,
      unitPrice: transaction.unitPrice,
      reference: transaction.reference,
      notes: transaction.notes,
      createdAt: transaction.createdAt,
    })
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/stock"
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au stock
        </Link>
        <PageHeader
          title={item.name}
          description={item.category ?? undefined}
          actions={
            <Link
              href={`/stock/${id}/edit`}
              className="rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Modifier
            </Link>
          }
        />
      </div>

      {item.currentQty < item.minQty && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-400">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
            Stock bas — {item.currentQty}/{item.minQty} {item.unit || "unités"} restants
          </p>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            Informations
          </h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-fg">Quantité actuelle</p>
              <p className="font-medium text-foreground">{item.currentQty}</p>
            </div>
            <div>
              <p className="text-muted-fg">Quantité minimale</p>
              <p className="font-medium text-foreground">{item.minQty}</p>
            </div>
            <div>
              <p className="text-muted-fg">Unité</p>
              <p className="font-medium text-foreground">{item.unit || "-"}</p>
            </div>
            <div>
              <p className="text-muted-fg">Statut</p>
              <div>
                <StockStatusBadge
                  currentQty={item.currentQty}
                  minQty={item.minQty}
                />
              </div>
            </div>
            <div>
              <p className="text-muted-fg">Prix d&apos;achat</p>
              <p className="font-medium text-foreground">
                {item.purchasePrice ? formatCurrency(item.purchasePrice) : "-"}
              </p>
            </div>
            <div>
              <p className="text-muted-fg">Prix de vente</p>
              <p className="font-medium text-foreground">
                {item.sellingPrice ? formatCurrency(item.sellingPrice) : "-"}
              </p>
            </div>
          </div>
          {item.description && (
            <div>
              <p className="text-sm text-muted-fg">Description</p>
              <p className="text-sm text-foreground mt-1">{item.description}</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            Nouveau mouvement
          </h2>
          <StockTransactionForm itemId={id} defaultType={defaultType} />
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card">
        <div className="px-6 py-4 border-b border-border-card">
          <h2 className="text-lg font-semibold text-foreground">
            Historique des mouvements
          </h2>
        </div>
        <StockTransactionsTable
          data={transactionRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>
    </div>
  );
}
