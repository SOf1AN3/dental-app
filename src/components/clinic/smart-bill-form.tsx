"use client";

import { useEffect } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";

/**
 * Wraps the createInvoice server action so that on success we redirect
 * to the newly-created invoice detail page (FACT-4).
 *
 * Server action signature: (prevState, formData) => { success?, error?, invoiceId? }
 */

type ActionState = {
  success?: boolean;
  error?: Record<string, string[]>;
  invoiceId?: string;
} | undefined;

export function SmartBillForm({
  action,
  notes,
}: {
  action: (prevState: ActionState, fd: FormData) => Promise<ActionState>;
  notes: string;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(action, undefined);

  useEffect(() => {
    if (state?.success && state.invoiceId) {
      router.push(`/billing/invoices/${state.invoiceId}`);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="notes" value={notes} />
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {isPending ? "Création…" : "Créer facture"}
      </button>
    </form>
  );
}
