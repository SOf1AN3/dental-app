import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { formatCurrency } from "@/lib/utils";
import {
  TreatmentCatalogActions,
} from "./treatment-catalog-actions";

export const dynamic = "force-dynamic";

export default async function TreatmentCatalogPage() {
  await requireAuth();

  const items = await getTreatmentCatalog();

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-cool-900">
              Catalogue de traitements
            </h2>
            <p className="text-sm text-cool-500">
              Gérez la liste des traitements proposés par votre clinique.
            </p>
          </div>
          <TreatmentCatalogActions />
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-cool-200 p-12 text-center">
            <p className="text-sm text-cool-400">
              Aucun traitement dans le catalogue. Cliquez sur &quot;Nouveau traitement&quot; pour ajouter le premier.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 text-left">
                  <th className="pb-3 pr-4 font-medium text-cool-500">Nom</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Code</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Catégorie</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500 text-right">Prix (DA)</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Statut</th>
                  <th className="pb-3 font-medium text-cool-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-cool-100">
                    <td className="py-3 pr-4 font-medium text-cool-900">
                      {item.name}
                    </td>
                    <td className="py-3 pr-4 text-cool-500">
                      {item.code || "—"}
                    </td>
                    <td className="py-3 pr-4 text-cool-500">
                      {item.category || "—"}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-cool-900">
                      {formatCurrency(item.price)}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          item.isActive
                            ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                            : "bg-cool-100 text-cool-500"
                        }`}
                      >
                        {item.isActive ? "Actif" : "Inactif"}
                      </span>
                    </td>
                    <td className="py-3">
                      {/* Actions are handled client-side via link/dialog trigger */}
                      <TreatmentCatalogActions item={item} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
