"use client";

import { useActionState } from "react";
import { createStockTransaction } from "@/lib/actions/inventory";

interface StockTransactionFormProps {
  itemId: string;
  defaultType?: "in" | "out";
  onSuccess?: () => void;
}

export function StockTransactionForm({
  itemId,
  defaultType,
  onSuccess,
}: StockTransactionFormProps) {
  const [state, formAction, pending] = useActionState(
    createStockTransaction,
    undefined,
  );

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="itemId" value={itemId} />

      <div>
        <label htmlFor="type" className="block text-sm font-medium text-cool-700">
          Type de mouvement *
        </label>
        <select
          id="type"
          name="type"
          required
          defaultValue={defaultType}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        >
          <option value="in">Entrée</option>
          <option value="out">Sortie</option>
          <option value="adjustment">Ajustement</option>
        </select>
        {fieldErrors?.type && (
          <p className="mt-1 text-xs text-red-500">{fieldErrors.type[0]}</p>
        )}
      </div>

      <div>
        <label htmlFor="qty" className="block text-sm font-medium text-cool-700">
          Quantité *
        </label>
        <input
          id="qty"
          name="qty"
          type="number"
          min="1"
          required
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
        {fieldErrors?.qty && (
          <p className="mt-1 text-xs text-red-500">{fieldErrors.qty[0]}</p>
        )}
      </div>

      <div>
        <label htmlFor="unitPrice" className="block text-sm font-medium text-cool-700">
          Prix unitaire (DA)
        </label>
        <input
          id="unitPrice"
          name="unitPrice"
          type="number"
          min="0"
          step="0.01"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div>
        <label htmlFor="reference" className="block text-sm font-medium text-cool-700">
          Référence
        </label>
        <input
          id="reference"
          name="reference"
          type="text"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-cool-700">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Enregistrement en cours..." : "Enregistrer le mouvement"}
        </button>
        {onSuccess && (
          <button
            type="button"
            onClick={onSuccess}
            className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
