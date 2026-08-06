"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createStockItem, updateStockItem } from "@/lib/actions/inventory";

interface StockItemFormProps {
  itemId?: string;
  defaultValues?: {
    name: string;
    category?: string | null;
    description?: string | null;
    currentQty: number;
    minQty: number;
    unit?: string | null;
    supplierId?: string | null;
    purchasePrice?: number | null;
    sellingPrice?: number | null;
  };
}

export function StockItemForm({ itemId, defaultValues }: StockItemFormProps) {
  const action = itemId
    ? updateStockItem.bind(null, itemId)
    : createStockItem;

  const [state, formAction, pending] = useActionState(action, undefined);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={formAction} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          {itemId ? "Modifier l'article" : "Nouvel article"}
        </h2>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label htmlFor="name" className="block text-sm font-medium text-cool-700">
              Nom *
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              defaultValue={defaultValues?.name}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
            {fieldErrors?.name && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
            )}
          </div>

          <div>
            <label htmlFor="category" className="block text-sm font-medium text-cool-700">
              Catégorie
            </label>
            <input
              id="category"
              name="category"
              type="text"
              defaultValue={defaultValues?.category || ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>

          <div>
            <label htmlFor="unit" className="block text-sm font-medium text-cool-700">
              Unité
            </label>
            <input
              id="unit"
              name="unit"
              type="text"
              defaultValue={defaultValues?.unit || ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-cool-700">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={defaultValues?.description || ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="currentQty" className="block text-sm font-medium text-cool-700">
              Quantité actuelle
            </label>
            <input
              id="currentQty"
              name="currentQty"
              type="number"
              min="0"
              defaultValue={defaultValues?.currentQty ?? 0}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>

          <div>
            <label htmlFor="minQty" className="block text-sm font-medium text-cool-700">
              Quantité minimale
            </label>
            <input
              id="minQty"
              name="minQty"
              type="number"
              min="0"
              defaultValue={defaultValues?.minQty ?? 0}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="purchasePrice" className="block text-sm font-medium text-cool-700">
              Prix d&apos;achat (DA)
            </label>
            <input
              id="purchasePrice"
              name="purchasePrice"
              type="number"
              min="0"
              step="0.01"
              defaultValue={defaultValues?.purchasePrice ?? ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>

          <div>
            <label htmlFor="sellingPrice" className="block text-sm font-medium text-cool-700">
              Prix de vente (DA)
            </label>
            <input
              id="sellingPrice"
              name="sellingPrice"
              type="number"
              min="0"
              step="0.01"
              defaultValue={defaultValues?.sellingPrice ?? ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending
            ? "Enregistrement en cours..."
            : itemId
              ? "Enregistrer"
              : "Créer l'article"}
        </button>
        <Link
          href="/stock"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
