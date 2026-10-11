"use client";

import { useRef } from "react";

/**
 * Wraps a status-change form (e.g. "Marquer payée") with a browser confirm
 * dialog. Z-33 — the previous message claimed the invoice would be "numérotée
 * et la TVA calculée automatiquement", which `updateInvoiceStatus` never does:
 * it only writes `invoices.status = 'paid'`, creates NO payment and touches
 * neither the numbering nor the tax. The dialog now states exactly what
 * happens (statut seul, sans encaissement), for drafts and non-drafts alike.
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
    const draftNotice = isDraft
      ? "Attention : la facture est encore un brouillon et ne sera ni numérotée ni recalculée (TVA) par cette action.\n"
      : "";
    const msg =
      `${draftNotice}Aucun paiement ne sera enregistré : seul le statut de la facture passera à « payée ».\n` +
      "Marquer cette facture comme payée ?";
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
