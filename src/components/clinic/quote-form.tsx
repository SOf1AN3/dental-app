"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createQuote } from "@/lib/actions/financial";
import { searchPatients } from "@/lib/actions/patient";
import { QuoteLineItems, type QuoteLineItem } from "@/components/clinic/quote-line-items";
import type { CatalogItem } from "@/lib/treatment-catalog-utils";
import { A5FinancialDocument, type FinancialDocData } from "@/components/clinic/a5-financial-document";
import { A5_SHEET_WIDTH_PX, A5_SHEET_HEIGHT_PX } from "@/components/clinic/a5-styles";
import { docTotals } from "@/lib/billing-math";
import type { A5Template } from "@/lib/document-branding";
import { formatDate } from "@/lib/utils";

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
}

const inputClassName =
  "mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

export function QuoteForm({
  catalog,
  defaultTaxRate = 19,
  clinicTemplate,
}: {
  catalog?: CatalogItem[];
  defaultTaxRate?: number;
  clinicTemplate: A5Template;
}) {
  const [state, action, pending] = useActionState(createQuote, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selected, setSelected] = useState<PatientResult | null>(null);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const [items, setItems] = useState<QuoteLineItem[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");

  const previewRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const errors =
    state && "error" in state && state.error
      ? (state.error as Record<string, string[] | undefined>)
      : ({} as Record<string, string[] | undefined>);
  const generalErrors = errors.general;
  const itemErrors = errors.items;

  useEffect(() => {
    if (!query || selected) {
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const patients = await searchPatients(query);
        setResults(patients);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, selected]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function handleSelect(patient: PatientResult) {
    setSelected(patient);
    setQuery(`${patient.lastName} ${patient.firstName}`);
    setOpen(false);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setSelected(null);
    if (!value) setResults([]);
  }

  const scale = containerWidth > 0 ? Math.min(1, containerWidth / A5_SHEET_WIDTH_PX) : 1;

  const previewItems = items.filter((item) => item.description.trim().length > 0);
  const totals = docTotals(previewItems);

  const previewData: FinancialDocData = {
    docType: "quote",
    number: "",
    date: date ? formatDate(date) : "—",
    dueLabel: validUntil ? formatDate(validUntil) : null,
    patientName: selected ? `${selected.lastName} ${selected.firstName}` : "—",
    patientPhone: null,
    notes: notes.trim() || null,
    items: previewItems,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    discountTotal: totals.discountTotal,
    total: totals.total,
    paidAmount: null,
    statusLabel: null,
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <form action={action} className="space-y-6">
        <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
          {generalErrors && generalErrors.length > 0 && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {generalErrors[0]}
            </div>
          )}
          <h2 className="text-lg font-semibold text-foreground">
            Informations du devis
          </h2>

          <div ref={containerRef} className="relative">
            <label htmlFor="patientSearch" className="block text-sm font-medium text-foreground">
              Patient *
            </label>
            <input
              id="patientSearch"
              type="text"
              placeholder="Rechercher un patient..."
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onFocus={() => { if (results.length > 0) setOpen(true); }}
              className={inputClassName}
            />
            <input type="hidden" name="patientId" value={selected?.id || ""} />
            {errors?.patientId && (
              <p className="mt-1 text-xs text-destructive">{errors.patientId[0]}</p>
            )}
            {open && results.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded-lg border border-border-card bg-card shadow-lg max-h-48 overflow-y-auto">
                {results.map((p) => (
                  <li
                    key={p.id}
                    onClick={() => handleSelect(p)}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-cerulean/5 hover:text-cerulean transition-colors"
                  >
                    {p.lastName} {p.firstName}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="date" className="block text-sm font-medium text-foreground">
                Date *
              </label>
              <input
                id="date"
                name="date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClassName}
              />
              {errors?.date && (
                <p className="mt-1 text-xs text-destructive">{errors.date[0]}</p>
              )}
            </div>
            <div>
              <label htmlFor="validUntil" className="block text-sm font-medium text-foreground">
                Valide jusqu&apos;au
              </label>
              <input
                id="validUntil"
                name="validUntil"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className={inputClassName}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Lignes du devis
            </label>
            <QuoteLineItems
              catalog={catalog}
              defaultTaxRate={defaultTaxRate}
              onItemsChange={setItems}
            />
            {itemErrors && itemErrors.length > 0 && (
              <p className="mt-1 text-xs text-destructive">{itemErrors[0]}</p>
            )}
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-foreground">
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={inputClassName + " resize-y"}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            {pending ? "Création..." : "Créer le devis"}
          </button>
          <Link
            href="/billing/quotes"
            className="rounded-lg border border-border-input px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Annuler
          </Link>
        </div>
      </form>

      <div className="hidden lg:block lg:sticky lg:top-24 self-start">
        <p className="mb-2 text-xs font-medium text-muted-fg uppercase tracking-wider">
          Aperçu A5
        </p>
        <div ref={previewRef} className="w-full">
          <div
            className="overflow-hidden rounded-lg border border-border-card shadow-lg"
            style={{ width: A5_SHEET_WIDTH_PX * scale, height: A5_SHEET_HEIGHT_PX * scale }}
          >
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                width: "148mm",
                height: "210mm",
              }}
            >
              <A5FinancialDocument template={clinicTemplate} data={previewData} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}