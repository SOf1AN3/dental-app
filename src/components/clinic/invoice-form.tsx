"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createInvoice } from "@/lib/actions/financial";
import { searchPatients } from "@/lib/actions/patient";
import { InvoiceLineItems, type InvoiceLineItem } from "@/components/clinic/invoice-line-items";
import type { CatalogItem } from "@/lib/treatment-catalog-utils";
import { A5FinancialDocument, type FinancialDocData } from "@/components/clinic/a5-financial-document";
import { A5_SHEET_WIDTH_PX, A5_SHEET_HEIGHT_PX } from "@/components/clinic/a5-styles";
import { docTotals } from "@/lib/billing-math";
import type { A5Template } from "@/lib/document-branding";
import { formatDate } from "@/lib/utils";

interface Patient {
  id: string;
  firstName: string;
  lastName: string;
}

const inputClassName =
  "mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

export function InvoiceForm({
  catalog,
  defaultTaxRate = 19,
  clinicTemplate,
}: {
  catalog?: CatalogItem[];
  defaultTaxRate?: number;
  clinicTemplate: A5Template;
}) {
  const [state, action, pending] = useActionState(createInvoice, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [items, setItems] = useState<InvoiceLineItem[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  const previewRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const errors = state && 'error' in state && state.error
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;
  const generalErrors = errors.general;
  const itemErrors = errors.items;

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      if (query.length < 2) {
        setResults([]);
        return;
      }
      const patients = await searchPatients(query);
      setResults(patients);
      setOpen(true);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
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

  const scale = containerWidth > 0 ? Math.min(1, containerWidth / A5_SHEET_WIDTH_PX) : 1;

  const previewItems = items.filter((item) => item.description.trim().length > 0);
  const totals = docTotals(previewItems);

  const previewData: FinancialDocData = {
    docType: "invoice",
    number: "",
    date: date ? formatDate(date) : "—",
    dueLabel: dueDate ? formatDate(dueDate) : null,
    patientName: selectedPatient
      ? `${selectedPatient.lastName} ${selectedPatient.firstName}`
      : "—",
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
            Nouvelle facture
          </h2>

          <div ref={containerRef} className="relative">
            <label
              htmlFor="patientSearch"
              className="block text-sm font-medium text-foreground"
            >
              Patient *
            </label>
            <input
              id="patientSearch"
              type="text"
              placeholder="Rechercher un patient..."
              value={selectedPatient ? `${selectedPatient.lastName} ${selectedPatient.firstName}` : query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedPatient(null);
                const input = document.getElementById(
                  "patientId",
                ) as HTMLInputElement;
                if (input) input.value = "";
              }}
              onFocus={() => {
                if (results.length > 0) setOpen(true);
              }}
              className={inputClassName}
            />
            <input id="patientId" name="patientId" type="hidden" />
            {open && results.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-border-card bg-card shadow-lg">
                {results.map((patient) => (
                  <button
                    key={patient.id}
                    type="button"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-muted transition-colors"
                    onClick={() => {
                      setSelectedPatient(patient);
                      setQuery("");
                      setResults([]);
                      setOpen(false);
                      const input = document.getElementById(
                        "patientId",
                      ) as HTMLInputElement;
                      if (input) input.value = patient.id;
                    }}
                  >
                    {patient.lastName} {patient.firstName}
                  </button>
                ))}
              </div>
            )}
            {errors?.patientId && (
              <p className="mt-1 text-xs text-destructive">
                {errors.patientId[0]}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="date"
                className="block text-sm font-medium text-foreground"
              >
                Date de la facture *
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
                <p className="mt-1 text-xs text-destructive">
                  {errors.date[0]}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="dueDate"
                className="block text-sm font-medium text-foreground"
              >
                Date d&apos;échéance
              </label>
              <input
                id="dueDate"
                name="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={inputClassName}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Lignes de facture
            </label>
            <InvoiceLineItems
              catalog={catalog}
              defaultTaxRate={defaultTaxRate}
              onItemsChange={setItems}
            />
            {itemErrors && itemErrors.length > 0 && (
              <p className="mt-1 text-xs text-destructive">{itemErrors[0]}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="notes"
              className="block text-sm font-medium text-foreground"
            >
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
            {pending ? "Création en cours..." : "Créer la facture"}
          </button>
          <Link
            href="/billing/invoices"
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