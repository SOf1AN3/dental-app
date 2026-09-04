"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { convertQuoteToInvoice } from "@/lib/actions/financial";

/**
 * FACT-1 — "Facturer" button on the quote detail page. Calls the
 * transactional convertQuoteToInvoice action and navigates to the generated
 * invoice on success.
 */
export function ConvertQuoteButton({
  quoteId,
  disabled = false,
}: {
  quoteId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    convertQuoteToInvoice.bind(null, quoteId),
    undefined,
  );

  useEffect(() => {
    if (state && "invoiceId" in state && state.invoiceId) {
      router.push(`/billing/invoices/${state.invoiceId}`);
    }
  }, [state, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <button
          type="submit"
          disabled={pending || disabled}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Conversion..." : "Générer la facture"}
        </button>
      </form>
      {state && "error" in state && state.error && (
        <p className="text-xs text-red-500">{state.error}</p>
      )}
    </div>
  );
}
