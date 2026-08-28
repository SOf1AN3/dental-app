"use client";

import { useRef } from "react";

/**
 * Wraps a status-change form (e.g. "Marquer payée") with a browser confirm
 * dialog. When the invoice is still a draft, the message explains the
 * side-effects (numbering, TVA) so the user isn't caught off guard (FACT-3).
 */
export function ConfirmMarkPaidButton({
  action,
  invoiceId,
  isDraft,
}: {
  action: (fd: FormData) => void;
  invoiceId: string;
  isDraft: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent) {
    const msg = isDraft
      ? "La facture sera numérotée et la TVA calculée automatiquement.\nMarquer cette facture comme payée ?"
      : "Marquer cette facture comme payée ?";
    if (!window.confirm(msg)) {
      e.preventDefault();
    }
  }

  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={handleSubmit}
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="status" value="paid" />
      <button
        type="submit"
        className="rounded-lg bg-mint px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-colors"
      >
        Marquer payée
      </button>
    </form>
  );
}
