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
        <label htmlFor="type" className="block text-sm font-medium text-foreground">
          Type de mouvement *
        </label>
        <select
          id="type"
          name="type"
          required
          defaultValue={defaultType}
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        >
          <option value="in">Entrée</option>
          <option value="out">Sortie</option>
          <option value="adjustment">Ajustement</option>
        </select>
        {fieldErrors?.type && (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.type[0]}</p>
        )}
      </div>

      <div>
        <label htmlFor="qty" className="block text-sm font-medium text-foreground">
          Quantité *
        </label>
        <input
          id="qty"
          name="qty"
          type="number"
          min="1"
          required
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
        {fieldErrors?.qty && (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.qty[0]}</p>
        )}
      </div>

      <div>
        <label htmlFor="unitPrice" className="block text-sm font-medium text-foreground">
          Prix unitaire (DA)
        </label>
        <input
          id="unitPrice"
          name="unitPrice"
          type="number"
          min="0"
          step="0.01"
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      <div>
        <label htmlFor="reference" className="block text-sm font-medium text-foreground">
          Référence
        </label>
        <input
          id="reference"
          name="reference"
          type="text"
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-foreground">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending ? "Enregistrement en cours..." : "Enregistrer le mouvement"}
        </button>
        {onSuccess && (
          <button
            type="button"
            onClick={onSuccess}
            className="rounded-lg border border-border-input px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
