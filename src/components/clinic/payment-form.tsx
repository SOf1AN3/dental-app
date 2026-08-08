"use client";

import { useActionState } from "react";
import { recordPayment } from "@/lib/actions/financial";

interface PaymentFormProps {
  patientId: string;
  invoiceId?: string;
}

const paymentMethods = [
  { value: "cash", label: "Espèces" },
  { value: "check", label: "Chèque" },
  { value: "card", label: "Carte bancaire" },
  { value: "transfer", label: "Virement" },
];

export function PaymentForm({ patientId, invoiceId }: PaymentFormProps) {
  const [state, action, pending] = useActionState(
    recordPayment.bind(null, patientId),
    undefined,
  );

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Nouveau paiement
        </h2>

        {invoiceId && (
          <input
            id="invoiceId"
            name="invoiceId"
            type="hidden"
            value={invoiceId}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="amount"
              className="block text-sm font-medium text-cool-700"
            >
              Montant (DZD) *
            </label>
            <input
              id="amount"
              name="amount"
              type="number"
              step="0.01"
              min="0"
              required
              placeholder="0.00"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
            {fieldErrors?.amount && (
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.amount[0]}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="method"
              className="block text-sm font-medium text-cool-700"
            >
              Mode de paiement *
            </label>
            <select
              id="method"
              name="method"
              required
              defaultValue=""
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            >
              <option value="" disabled>
                Sélectionner...
              </option>
              {paymentMethods.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {fieldErrors?.method && (
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.method[0]}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="reference"
              className="block text-sm font-medium text-cool-700"
            >
              Référence
            </label>
            <input
              id="reference"
              name="reference"
              type="text"
              placeholder="N° de chèque, transaction..."
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>

          <div>
            <label
              htmlFor="date"
              className="block text-sm font-medium text-cool-700"
            >
              Date de paiement *
            </label>
            <input
              id="date"
              name="date"
              type="date"
              required
              defaultValue={new Date().toISOString().split("T")[0]}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
            {fieldErrors?.date && (
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.date[0]}
              </p>
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-cool-700"
          >
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Enregistrement..." : "Enregistrer le paiement"}
        </button>
      </div>
    </form>
  );
}
