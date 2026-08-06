import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getStockItem } from "@/lib/actions/inventory";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCurrency, formatDate } from "@/lib/utils";
import { StockStatusBadge } from "@/components/clinic/stock-status-badge";
import { StockTransactionForm } from "@/components/clinic/stock-transaction-form";

const typeLabels: Record<string, string> = {
  in: "Entrée",
  out: "Sortie",
  adjustment: "Ajustement",
};

const typeColors: Record<string, string> = {
  in: "bg-mint/10 text-mint",
  out: "bg-red-50 text-red-600",
  adjustment: "bg-amber-50 text-amber-700",
};

export default async function StockItemDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const item = await getStockItem(id);

  if (!item) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">{item.name}</h1>
          {item.category && (
            <p className="text-sm text-cool-500">{item.category}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/stock/${id}/edit`}
            className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            Modifier
          </Link>
          <Link
            href="/stock"
            className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            Retour
          </Link>
        </div>
      </div>

      {item.currentQty < item.minQty && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            Stock bas — {item.currentQty}/{item.minQty} {item.unit || "unités"} restants
          </p>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
          <h2 className="text-lg font-semibold text-cool-900">
            Informations
          </h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-cool-500">Quantité actuelle</p>
              <p className="font-medium text-cool-900">{item.currentQty}</p>
            </div>
            <div>
              <p className="text-cool-500">Quantité minimale</p>
              <p className="font-medium text-cool-900">{item.minQty}</p>
            </div>
            <div>
              <p className="text-cool-500">Unité</p>
              <p className="font-medium text-cool-900">{item.unit || "-"}</p>
            </div>
            <div>
              <p className="text-cool-500">Statut</p>
              <div>
                <StockStatusBadge
                  currentQty={item.currentQty}
                  minQty={item.minQty}
                />
              </div>
            </div>
            <div>
              <p className="text-cool-500">Prix d&apos;achat</p>
              <p className="font-medium text-cool-900">
                {item.purchasePrice ? formatCurrency(item.purchasePrice) : "-"}
              </p>
            </div>
            <div>
              <p className="text-cool-500">Prix de vente</p>
              <p className="font-medium text-cool-900">
                {item.sellingPrice ? formatCurrency(item.sellingPrice) : "-"}
              </p>
            </div>
          </div>
          {item.description && (
            <div>
              <p className="text-sm text-cool-500">Description</p>
              <p className="text-sm text-cool-900 mt-1">{item.description}</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
          <h2 className="text-lg font-semibold text-cool-900">
            Nouveau mouvement
          </h2>
          <StockTransactionForm itemId={id} />
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white">
        <div className="px-6 py-4 border-b border-cool-200">
          <h2 className="text-lg font-semibold text-cool-900">
            Historique des mouvements
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cool-200 bg-cool-50">
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Qté
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Prix unitaire
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Référence
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody>
              {item.transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                >
                  <td className="px-6 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium ${
                        typeColors[tx.type] || "bg-cool-100 text-cool-600"
                      }`}
                    >
                      {typeLabels[tx.type] || tx.type}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-medium text-cool-900">
                    {tx.qty}
                  </td>
                  <td className="px-6 py-3 text-cool-600">
                    {tx.unitPrice ? formatCurrency(tx.unitPrice) : "-"}
                  </td>
                  <td className="px-6 py-3 text-cool-600">
                    {tx.reference || "-"}
                  </td>
                  <td className="px-6 py-3 text-cool-600">
                    {formatDate(tx.createdAt)}
                  </td>
                  <td className="px-6 py-3 text-cool-500 max-w-xs truncate">
                    {tx.notes || "-"}
                  </td>
                </tr>
              ))}
              {item.transactions.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-cool-400"
                  >
                    Aucun mouvement enregistré
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
