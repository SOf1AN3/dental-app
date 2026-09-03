"use client";

import { useState } from "react";
import { TreatmentCatalogInlineForm } from "@/components/clinic/treatment-catalog-form";
import { deleteTreatmentCatalogItem, toggleTreatmentCatalogItemActive } from "@/lib/actions/treatment-catalog";
import type { treatmentCatalog } from "@/lib/db/schema";

type CatalogItem = typeof treatmentCatalog.$inferSelect;

export function TreatmentCatalogActions({ item }: { item?: CatalogItem }) {
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);

  const isListView = !!item;

  if (!isListView) {
    // This is the "Nouveau traitement" button
    return (
      <>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          Nouveau traitement
        </button>
        {showForm && (
          <div className="mt-6">
            <TreatmentCatalogInlineForm onClose={() => setShowForm(false)} />
          </div>
        )}
      </>
    );
  }

  const handleToggleActive = async () => {
    if (!confirm(item.isActive ? "Désactiver ce traitement ?" : "Activer ce traitement ?")) return;
    const result = await toggleTreatmentCatalogItemActive(item.id, !item.isActive);
    if (result.error) {
      alert(result.error);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Supprimer ce traitement ? Cette action est irréversible.")) return;
    const result = await deleteTreatmentCatalogItem(item.id);
    if (result.error) {
      alert(result.error);
    }
  };

  return (
    <>
      {editingItem ? (
        <div className="col-span-full mt-4">
          <TreatmentCatalogInlineForm
            item={editingItem}
            onClose={() => setEditingItem(null)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditingItem(item)}
            className="text-sm text-cerulean hover:text-cerulean-dark transition-colors"
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
            className="text-sm text-red-500 hover:text-red-600 transition-colors"
          >
            Supprimer
          </button>
        </div>
      )}
    </>
  );
}
