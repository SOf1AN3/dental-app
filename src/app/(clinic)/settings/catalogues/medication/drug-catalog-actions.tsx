"use client";

import { useState } from "react";
import { DrugCatalogInlineForm } from "@/components/clinic/drug-catalog-form";
import { deleteDrug, toggleDrugActive } from "@/lib/actions/drug-catalog";
import type { drugCatalog } from "@/lib/db/schema";

type CatalogItem = typeof drugCatalog.$inferSelect;

export function DrugCatalogActions({ item }: { item?: CatalogItem }) {
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);

  const isListView = !!item;

  if (!isListView) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          Nouveau médicament
        </button>
        {showForm && (
          <div className="mt-6">
            <DrugCatalogInlineForm onClose={() => setShowForm(false)} />
          </div>
        )}
      </>
    );
  }

  const handleToggleActive = async () => {
    if (!confirm(item.isActive ? "Désactiver ce médicament ?" : "Activer ce médicament ?")) return;
    const result = await toggleDrugActive(item.id, !item.isActive);
    if (result.error) {
      alert(result.error);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Supprimer ce médicament ? Cette action est irréversible.")) return;
    const result = await deleteDrug(item.id);
    if (result.error) {
      alert(result.error);
    }
  };

  return (
    <>
      {editingItem ? (
        <div className="col-span-full mt-4">
          <DrugCatalogInlineForm
            item={editingItem}
            onClose={() => setEditingItem(null)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditingItem(item)}
            className="text-sm text-cerulean hover:text-cerulean-dark transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Modifier
          </button>
          <button
            type="button"
            onClick={handleToggleActive}
            className={`text-sm transition-colors ${
              item.isActive
                ? "text-amber-600 hover:text-amber-700"
                : "text-green-600 hover:text-green-700"
            }`}
          >
            {item.isActive ? "Désactiver" : "Activer"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="text-sm text-destructive underline-offset-4 hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Supprimer
          </button>
        </div>
      )}
    </>
  );
}
