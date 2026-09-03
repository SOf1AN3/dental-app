import { requireAuth } from "@/lib/auth-utils";
import { getDrugCatalog } from "@/lib/actions/drug-catalog";
import { Download } from "lucide-react";
import { DrugCatalogActions } from "./drug-catalog-actions";
import { DrugUploadForm } from "./drug-upload-form";

export const dynamic = "force-dynamic";

export default async function MedicationCatalogPage() {
  await requireAuth();

  const drugs = await getDrugCatalog();

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-cool-200 bg-white p-6">
        <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-cool-900">
              Catalogue de médicaments
            </h2>
            <p className="text-sm text-cool-500">
              Gérez les médicaments utilisés dans les ordonnances. Importez un fichier Excel (.xlsx)
              ou ajoutez des médicaments manuellement.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DrugUploadForm />
            <a
              href="/api/drugs/export"
              className="inline-flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-700 hover:bg-cool-50 transition-colors"
              title="Télécharger la liste des médicaments au format Excel"
            >
              <Download className="h-4 w-4" />
              Exporter
            </a>
            <DrugCatalogActions />
          </div>
        </div>

        {drugs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-cool-200 p-12 text-center">
            <p className="text-sm text-cool-400">
              Aucun médicament dans le catalogue. Importez un fichier Excel ou cliquez sur
              &quot;Nouveau médicament&quot; pour ajouter le premier.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 text-left">
                  <th className="pb-3 pr-4 font-medium text-cool-500">Nom</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Dosage</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Forme</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Catégorie</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Fréquence</th>
                  <th className="pb-3 pr-4 font-medium text-cool-500">Statut</th>
                  <th className="pb-3 font-medium text-cool-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {drugs.map((drug) => (
                  <tr key={drug.id} className="border-b border-cool-100">
                    <td className="py-3 pr-4 font-medium text-cool-900">{drug.name}</td>
                    <td className="py-3 pr-4 text-cool-500">{drug.dosage || "—"}</td>
                    <td className="py-3 pr-4 text-cool-500">{drug.form || "—"}</td>
                    <td className="py-3 pr-4 text-cool-500">{drug.category || "—"}</td>
                    <td className="py-3 pr-4 text-cool-500">{drug.frequency || "—"}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          drug.isActive
                            ? "bg-green-50 text-green-700"
                            : "bg-cool-100 text-cool-500"
                        }`}
                      >
                        {drug.isActive ? "Actif" : "Inactif"}
                      </span>
                    </td>
                    <td className="py-3">
                      <DrugCatalogActions item={drug} />
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
