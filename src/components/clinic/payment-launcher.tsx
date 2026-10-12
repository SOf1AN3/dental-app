"use client";

import { useEffect, useRef, useState } from "react";
import {
  getUnpaidInvoicesForPatient,
} from "@/lib/actions/financial";
import { searchPatients } from "@/lib/actions/patient";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PaymentForm } from "@/components/clinic/payment-form";

/**
 * Payment launcher used by /billing/payments/new.
 *
 * Two modes:
 * - preset (patient + invoice from query params): invoice select pre-filled,
 *   patient read-only, open invoices provided by the server;
 * - picker: debounced patient search, then choose one of the patient's open
 *   invoices (fetched on selection) before the PaymentForm appears.
 */

interface UnpaidInvoice {
  id: string;
  number: string;
  date: Date | string;
  total: number;
  status: string;
  paidAmount: number;
}

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
}

interface PaymentLauncherProps {
  presetPatient?: { id: string; firstName: string; lastName: string } | null;
  presetInvoiceId?: string | null;
  presetInvoices?: UnpaidInvoice[];
}

export function PaymentLauncher({
  presetPatient,
  presetInvoiceId,
  presetInvoices = [],
}: PaymentLauncherProps) {
  const [patient, setPatient] = useState<PatientResult | null>(presetPatient ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [open, setOpen] = useState(false);
  const [invoices, setInvoices] = useState<UnpaidInvoice[]>(presetInvoices);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoiceId, setInvoiceId] = useState<string>(presetInvoiceId ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (query.length < 2 || patient) {
        setResults([]);
        return;
      }
      try {
        const patients = await searchPatients(query);
        setResults(patients);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, patient]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleSelect(selected: PatientResult) {
    setPatient(selected);
    setInvoiceId("");
    setQuery("");
    setResults([]);
    setOpen(false);
    setLoadingInvoices(true);
    try {
      const rows = await getUnpaidInvoicesForPatient(selected.id);
      setInvoices(rows);
    } catch {
      setInvoices([]);
    } finally {
      setLoadingInvoices(false);
    }
  }

  const selectedInvoice = invoices.find((i) => i.id === invoiceId) ?? null;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4 max-w-2xl">
        <div>
          <label className="block text-sm font-medium text-foreground">Patient *</label>
          {patient ? (
            <div className="mt-1 flex items-center justify-between rounded-lg border border-cool-200 bg-cool-100 px-3 py-2">
              <span className="text-sm text-cool-700">
                {patient.lastName} {patient.firstName}
              </span>
              {!presetPatient && (
                <button
                  type="button"
                  onClick={() => {
                    setPatient(null);
                    setInvoices([]);
                    setInvoiceId("");
                  }}
                  className="text-xs text-cerulean hover:text-cerulean/80"
                >
                  Changer
                </button>
              )}
            </div>
          ) : (
            <div ref={containerRef} className="relative mt-1">
              <input
                type="text"
                placeholder="Rechercher un patient..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => {
                  if (results.length > 0) setOpen(true);
                }}
                className="block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              />
              {open && results.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white shadow-lg">
                  {results.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="block w-full px-4 py-2 text-left text-sm hover:bg-cool-50 transition-colors"
                      onClick={() => handleSelect(p)}
                    >
                      {p.lastName} {p.firstName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="invoiceSelect" className="block text-sm font-medium text-foreground">
            Facture *
          </label>
          <select
            id="invoiceSelect"
            value={invoiceId}
            disabled={!patient || loadingInvoices}
            onChange={(e) => setInvoiceId(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none disabled:opacity-60"
          >
            <option value="">
              {!patient
                ? "Choisissez d'abord un patient"
                : loadingInvoices
                  ? "Chargement..."
                  : invoices.length === 0
                    ? "Aucune facture ouverte pour ce patient"
                    : "Sélectionner une facture..."}
            </option>
            {invoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.number} — {formatDate(inv.date)} — dû :{" "}
                {formatCurrency(inv.total - inv.paidAmount)}
              </option>
            ))}
          </select>
          {selectedInvoice && selectedInvoice.paidAmount > 0 && (
            <p className="mt-1 text-xs text-cool-500">
              Déjà réglé : {formatCurrency(selectedInvoice.paidAmount)} sur{" "}
              {formatCurrency(selectedInvoice.total)}
            </p>
          )}
        </div>
      </div>

      {patient && invoiceId && (
        <PaymentForm key={`${patient.id}:${invoiceId}`} patientId={patient.id} invoiceId={invoiceId} />
      )}
    </div>
  );
}
