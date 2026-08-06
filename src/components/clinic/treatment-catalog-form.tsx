"use client";

import { useActionState } from "react";
import { createTreatmentCatalogItem, updateTreatmentCatalogItem } from "@/lib/actions/treatment-catalog";
import type { treatmentCatalog } from "@/lib/db/schema";

type CatalogItem = typeof treatmentCatalog.$inferSelect;

export function TreatmentCatalogForm({
  item,
  onClose,
}: {
  item?: CatalogItem | null;
  onClose?: () => void;
}) {
  const action = item
    ? updateTreatmentCatalogItem.bind(null, item.id)
    : createTreatmentCatalogItem;

  const [state, formAction, pending] = useActionState(action, undefined);

  const fieldErrors =
    state && "error" in state && state.error && !("general" in state.error)
      ? (state.error as Record<string, string[] | undefined>)
      : ({} as Record<string, string[] | undefined>);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label
            htmlFor="name"
            className="block text-sm font-medium text-cool-700"
          >
            Nom du traitement *
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            defaultValue={item?.name ?? ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {fieldErrors?.name && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="code"
            className="block text-sm font-medium text-cool-700"
          >
            Code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            defaultValue={item?.code ?? ""}
            placeholder="Ex: TRT001"
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>

        <div>
          <label
            htmlFor="category"
            className="block text-sm font-medium text-cool-700"
          >
            Catégorie
          </label>
          <input
            id="category"
            name="category"
            type="text"
            defaultValue={item?.category ?? ""}
            placeholder="Ex: Soins, Prothèse, Orthodontie"
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="price"
          className="block text-sm font-medium text-cool-700"
        >
          Prix (DA) *
        </label>
        <input
          id="price"
          name="price"
          type="number"
          required
          min={0}
          step="0.01"
          defaultValue={item?.price ?? 0}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
        {fieldErrors?.price && (
          <p className="mt-1 text-xs text-red-500">{fieldErrors.price[0]}</p>
        )}
      </div>

      <div>
        <label
          htmlFor="description"
          className="block text-sm font-medium text-cool-700"
        >
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={item?.description ?? ""}
          placeholder="Description optionnelle du traitement..."
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean resize-y"
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="isActive"
          name="isActive"
          type="checkbox"
          defaultChecked={item?.isActive ?? true}
          className="h-4 w-4 rounded border-cool-300 text-cerulean focus:ring-cerulean"
        />
        <label htmlFor="isActive" className="text-sm font-medium text-cool-700">
          Traitement actif
        </label>
      </div>

      {state?.success && (
        <p className="text-sm text-green-600">
          {item
            ? "Traitement mis à jour avec succès."
            : "Traitement ajouté avec succès."}
        </p>
      )}

      {fieldErrors?.general && (
        <p className="text-sm text-red-500">{fieldErrors.general[0]}</p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending
            ? "Enregistrement..."
            : item
              ? "Mettre à jour"
              : "Ajouter"}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-700 hover:bg-cool-50 transition-colors"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}

export function TreatmentCatalogInlineForm({
  item,
  onClose,
}: {
  item?: CatalogItem | null;
  onClose?: () => void;
}) {
  return (
    <div className="rounded-xl border border-cool-200 bg-white p-6">
      <h3 className="mb-4 text-base font-semibold text-cool-900">
        {item ? "Modifier le traitement" : "Ajouter un traitement"}
      </h3>
      <TreatmentCatalogForm item={item} onClose={onClose} />
    </div>
  );
}
