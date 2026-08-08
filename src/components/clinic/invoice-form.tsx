"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createInvoice } from "@/lib/actions/financial";
import { searchPatients } from "@/lib/actions/patient";
import { InvoiceLineItems } from "@/components/clinic/invoice-line-items";
import type { CatalogItem } from "@/lib/treatment-catalog-utils";

interface Patient {
  id: string;
  firstName: string;
  lastName: string;
}

export function InvoiceForm({ catalog }: { catalog?: CatalogItem[] }) {
  const [state, action, pending] = useActionState(createInvoice, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

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

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Nouvelle facture
        </h2>

        <div ref={containerRef} className="relative">
          <label
            htmlFor="patientSearch"
            className="block text-sm font-medium text-cool-700"
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
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          <input id="patientId" name="patientId" type="hidden" />
          {open && results.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white dark:bg-cool-100 shadow-lg">
              {results.map((patient) => (
                <button
                  key={patient.id}
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm hover:bg-cool-50 transition-colors"
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
          {fieldErrors?.patientId && (
            <p className="mt-1 text-xs text-red-500">
              {fieldErrors.patientId[0]}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="date"
              className="block text-sm font-medium text-cool-700"
            >
              Date de la facture *
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
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.date[0]}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="dueDate"
              className="block text-sm font-medium text-cool-700"
            >
              Date d&apos;échéance
            </label>
            <input
              id="dueDate"
              name="dueDate"
              type="date"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-cool-700 mb-2">
            Lignes de facture
          </label>
          <InvoiceLineItems catalog={catalog} />
        </div>

        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-cool-700"
          >
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
          {pending ? "Création en cours..." : "Créer la facture"}
        </button>
        <Link
          href="/billing/invoices"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
