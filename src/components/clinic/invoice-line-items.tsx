"use client";

/**
 * Invoice-specific re-export of the shared line-items editor
 * (invoice-form and quote-form were byte-identical clones; see
 * document-line-items.tsx for the single implementation).
 */
export { DocumentLineItems as InvoiceLineItems } from "./document-line-items";
export type { LineItem as InvoiceLineItem } from "./document-line-items";
