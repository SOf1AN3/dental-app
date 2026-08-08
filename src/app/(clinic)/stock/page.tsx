import { requireAuth } from "@/lib/auth-utils";
import { getStockItems, getLowStockItems } from "@/lib/actions/inventory";
import Link from "next/link";
import { StockStatusBadge } from "@/components/clinic/stock-status-badge";

export default async function StockPage() {
  await requireAuth();

  const [items, lowStockItems] = await Promise.all([
    getStockItems(),
    getLowStockItems(),
  ]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Stock</h1>
          <p className="text-sm text-cool-500">{items.length} articles</p>
        </div>
        <Link
          href="/stock/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouvel article
        </Link>
      </div>

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

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Nom
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Catégorie
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Qté
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Min
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Unité
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
            {items.map((item) => {
              const isLow = item.currentQty < item.minQty;
              return (
                <tr
                  key={item.id}
                  className={`border-b border-cool-100 hover:bg-cool-50 transition-colors ${
                    isLow ? "bg-red-50/30 dark:bg-red-500/10" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/stock/${item.id}`}
                      className="font-medium text-cerulean hover:text-cerulean/80"
                    >
                      {item.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-cool-600">
                    {item.category || "-"}
                  </td>
                  <td className={`px-4 py-3 font-medium ${isLow ? "text-red-600 dark:text-red-400" : "text-cool-900"}`}>
                    {item.currentQty}
                  </td>
                  <td className="px-4 py-3 text-cool-500">{item.minQty}</td>
                  <td className="px-4 py-3 text-cool-600">
                    {item.unit || "-"}
                  </td>
                  <td className="px-4 py-3">
                    <StockStatusBadge
                      currentQty={item.currentQty}
                      minQty={item.minQty}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/stock/${item.id}`}
                      className="text-sm text-cerulean hover:text-cerulean/80"
                    >
                      Détails
                    </Link>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-12 text-center text-cool-400"
                >
                  Aucun article en stock
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
