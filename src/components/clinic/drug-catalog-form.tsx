"use client";

import { useActionState } from "react";
import { createDrug, updateDrug } from "@/lib/actions/drug-catalog";
import type { drugCatalog } from "@/lib/db/schema";

type CatalogItem = typeof drugCatalog.$inferSelect;

const inputClassName =
  "mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

export function DrugCatalogForm({
  item,
  onClose,
}: {
  item?: CatalogItem | null;
  onClose?: () => void;
}) {
  const action = item
    ? updateDrug.bind(null, item.id)
    : createDrug;

  const [state, formAction, pending] = useActionState(action, undefined);

  const fieldErrors =
    state && "error" in state && state.error && !("general" in state.error)
      ? (state.error as Record<string, string[] | undefined>)
      : ({} as Record<string, string[] | undefined>);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label htmlFor="name" className="block text-sm font-medium text-foreground">
            Nom du médicament *
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            defaultValue={item?.name ?? ""}
            placeholder="Ex: Amoxicilline"
            className={inputClassName}
          />
          {fieldErrors?.name && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
          )}
        </div>

        <div>
          <label htmlFor="dosage" className="block text-sm font-medium text-foreground">
            Dosage
          </label>
          <input
            id="dosage"
            name="dosage"
            type="text"
            defaultValue={item?.dosage ?? ""}
            placeholder="Ex: 500mg"
            className={inputClassName}
          />
        </div>

        <div>
          <label htmlFor="form" className="block text-sm font-medium text-foreground">
            Forme
          </label>
          <input
            id="form"
            name="form"
            type="text"
            defaultValue={item?.form ?? ""}
            placeholder="Ex: Comprimé, Sirop"
            className={inputClassName}
          />
        </div>

        <div className="col-span-2">
          <label htmlFor="category" className="block text-sm font-medium text-foreground">
            Catégorie
          </label>
          <input
            id="category"
            name="category"
            type="text"
            defaultValue={item?.category ?? ""}
            placeholder="Ex: Antibiotique, Antalgique"
            className={inputClassName}
          />
        </div>

        <div className="col-span-2">
          <label htmlFor="frequency" className="block text-sm font-medium text-foreground">
            Fréquence suggérée
          </label>
          <input
            id="frequency"
            name="frequency"
            type="text"
            defaultValue={item?.frequency ?? ""}
            placeholder="Ex: 3 fois par jour"
            className={inputClassName}
          />
        </div>

        <div className="col-span-2">
          <label htmlFor="instructions" className="block text-sm font-medium text-foreground">
            Instructions par défaut
          </label>
          <textarea
            id="instructions"
            name="instructions"
            rows={3}
            defaultValue={item?.instructions ?? ""}
            placeholder="Instructions par défaut..."
            className={`${inputClassName} resize-y`}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="isActive"
          name="isActive"
          type="checkbox"
          defaultChecked={item?.isActive ?? true}
          className="h-4 w-4 rounded border-input text-cerulean focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <label htmlFor="isActive" className="text-sm font-medium text-foreground">
          Médicament actif
        </label>
      </div>

      {state?.success && (
        <p className="text-sm text-green-600">
          {item
            ? "Médicament mis à jour avec succès."
            : "Médicament ajouté avec succès."}
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

export function DrugCatalogInlineForm({
  item,
  onClose,
}: {
  item?: CatalogItem | null;
  onClose?: () => void;
}) {
  return (
    <div className="rounded-xl border border-border-card bg-card p-6">
      <h3 className="mb-4 text-base font-semibold text-cool-900">
        {item ? "Modifier le médicament" : "Ajouter un médicament"}
      </h3>
      <DrugCatalogForm item={item} onClose={onClose} />
    </div>
  );
}
