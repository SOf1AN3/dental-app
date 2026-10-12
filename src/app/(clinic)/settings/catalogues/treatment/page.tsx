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
      <section className="rounded-xl border border-border-card bg-card p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Catalogue de traitements
            </h2>
            <p className="text-sm text-muted-fg">
              Gérez la liste des traitements proposés par votre clinique.
            </p>
          </div>
          <TreatmentCatalogActions />
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-card p-12 text-center">
            <p className="text-sm text-muted-fg">
              Aucun traitement dans le catalogue. Cliquez sur &quot;Nouveau traitement&quot; pour ajouter le premier.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-card text-left">
                  <th className="pb-3 pr-4 font-medium text-muted-fg">Nom</th>
                  <th className="pb-3 pr-4 font-medium text-muted-fg">Code</th>
                  <th className="pb-3 pr-4 font-medium text-muted-fg">Catégorie</th>
                  <th className="pb-3 pr-4 font-medium text-muted-fg text-right">Prix (DA)</th>
                  <th className="pb-3 pr-4 font-medium text-muted-fg">Statut</th>
                  <th className="pb-3 font-medium text-muted-fg">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-cool-100">
                    <td className="py-3 pr-4 font-medium text-foreground">
                      {item.name}
                    </td>
                    <td className="py-3 pr-4 text-muted-fg">
                      {item.code || "—"}
                    </td>
                    <td className="py-3 pr-4 text-muted-fg">
                      {item.category || "—"}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-foreground">
                      {formatCurrency(item.price)}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          item.isActive
                            ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                            : "bg-cool-100 text-muted-fg"
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
