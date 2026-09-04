"use client";

/**
 * Quote-specific re-export of the shared line-items editor
 * (quote-form and invoice-form were byte-identical clones; see
 * document-line-items.tsx for the single implementation).
 */
export { DocumentLineItems as QuoteLineItems } from "./document-line-items";
export type { LineItem as QuoteLineItem } from "./document-line-items";
