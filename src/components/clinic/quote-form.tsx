"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createQuote } from "@/lib/actions/financial";
import { searchPatients } from "@/lib/actions/patient";
import { QuoteLineItems } from "@/components/clinic/quote-line-items";
import type { CatalogItem } from "@/lib/treatment-catalog-utils";

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
}

export function QuoteForm({ catalog }: { catalog?: CatalogItem[] }) {
  const [state, action, pending] = useActionState(createQuote, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selected, setSelected] = useState<PatientResult | null>(null);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

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

  return (
    <form action={action} className="max-w-xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Informations du devis
        </h2>

        <div ref={containerRef} className="relative">
          <label htmlFor="patientSearch" className="block text-sm font-medium text-cool-700">
            Patient *
          </label>
          <input
            id="patientSearch"
            type="text"
            placeholder="Rechercher un patient..."
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={() => { if (results.length > 0) setOpen(true); }}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          <input type="hidden" name="patientId" value={selected?.id || ""} />
          {fieldErrors?.patientId && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.patientId[0]}</p>
          )}
          {open && results.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white shadow-lg max-h-48 overflow-y-auto">
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
            <label htmlFor="date" className="block text-sm font-medium text-cool-700">
              Date *
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
              <p className="mt-1 text-xs text-red-500">{fieldErrors.date[0]}</p>
            )}
          </div>
          <div>
            <label htmlFor="validUntil" className="block text-sm font-medium text-cool-700">
              Valide jusqu&apos;au
            </label>
            <input
              id="validUntil"
              name="validUntil"
              type="date"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-cool-700 mb-2">
            Lignes du devis
          </label>
          <QuoteLineItems catalog={catalog} />
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-cool-700">
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
          {pending ? "Création..." : "Créer le devis"}
        </button>
        <Link
          href="/billing/quotes"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
