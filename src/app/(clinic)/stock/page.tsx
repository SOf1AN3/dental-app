import { Plus } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { getStockItems, getLowStockItems } from "@/lib/actions/inventory";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { StockTable, type StockTableRow } from "@/components/clinic/stock-table";

export default async function StockPage() {
  await requireAuth();

  const [items, lowStockItems] = await Promise.all([
    getStockItems(),
    getLowStockItems(),
  ]);

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const stockRows: StockTableRow[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    currentQty: item.currentQty,
    minQty: item.minQty,
    unit: item.unit,
  }));

  return (
    <div>
      <PageHeader
        title="Stock"
        description={`${items.length} articles`}
        actions={
          <Link
            href="/stock/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nouvel article
          </Link>
        }
      />

      {lowStockItems.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-400">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
            {lowStockItems.length} article{lowStockItems.length > 1 ? "s" : ""} en stock bas
          </p>
          <ul className="mt-2 list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
            {lowStockItems.map((item) => (
              <li key={item.id}>
                <Link href={`/stock/${item.id}`} className="hover:underline">
                  {item.name}
                </Link>
                <span className="text-amber-500">
                  {" "}({item.currentQty}/{item.minQty} {item.unit})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <StockTable data={stockRows} />
    </div>
  );
}
