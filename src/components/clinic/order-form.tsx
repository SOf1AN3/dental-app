"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createOrder } from "@/lib/actions/prosthesis";
import { searchPatients } from "@/lib/actions/patient";
import { getLabs } from "@/lib/actions/prosthesis";

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
}

interface LabResult {
  id: string;
  name: string;
}

export function OrderForm() {
  const [state, action, pending] = useActionState(createOrder, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientResult | null>(null);
  const [open, setOpen] = useState(false);
  const [labs, setLabs] = useState<LabResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  useEffect(() => {
    getLabs().then(setLabs);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query || query.length < 2) return;
    timerRef.current = setTimeout(async () => {
      const patients = await searchPatients(query);
      setResults(patients);
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Nouvelle commande de prothèse
        </h2>

        <div ref={containerRef} className="relative">
          <label htmlFor="patientSearch" className="block text-sm font-medium text-cool-700">
            Patient *
          </label>
          {selectedPatient ? (
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm">
              <span className="flex-1">
                {selectedPatient.lastName} {selectedPatient.firstName}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedPatient(null);
                  setQuery("");
                  setResults([]);
                }}
                className="text-cool-400 hover:text-cool-600 text-lg leading-none"
              >
                &times;
              </button>
            </div>
          ) : (
            <input
              id="patientSearch"
              type="text"
              placeholder="Rechercher un patient..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                if (e.target.value.length < 2) setResults([]);
              }}
              onFocus={() => setOpen(true)}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          )}
          <input type="hidden" name="patientId" value={selectedPatient?.id || ""} />
          {open && results.length > 0 && !selectedPatient && (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white shadow-lg max-h-48 overflow-y-auto">
              {results.map((p) => (
                <li
                  key={p.id}
                  onClick={() => {
                    setSelectedPatient(p);
                    setQuery("");
                    setResults([]);
                    setOpen(false);
                  }}
                  className="px-3 py-2 text-sm hover:bg-cool-50 cursor-pointer"
                >
                  {p.lastName} {p.firstName}
                </li>
              ))}
            </ul>
          )}
          {fieldErrors?.patientId && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.patientId[0]}</p>
          )}
        </div>

        <div>
          <label htmlFor="labId" className="block text-sm font-medium text-cool-700">
            Laboratoire
          </label>
          <select
            id="labId"
            name="labId"
            defaultValue=""
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          >
            <option value="">Sélectionner un laboratoire</option>
            {labs.map((lab) => (
              <option key={lab.id} value={lab.id}>
                {lab.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-cool-700">
            Description *
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {fieldErrors?.description && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.description[0]}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="toothNumber" className="block text-sm font-medium text-cool-700">
              N° dent
            </label>
            <input
              id="toothNumber"
              name="toothNumber"
              type="number"
              min={1}
              max={48}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label htmlFor="material" className="block text-sm font-medium text-cool-700">
              Matériau
            </label>
            <input
              id="material"
              name="material"
              type="text"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label htmlFor="color" className="block text-sm font-medium text-cool-700">
              Couleur
            </label>
            <input
              id="color"
              name="color"
              type="text"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="deliveryDate" className="block text-sm font-medium text-cool-700">
              Date de livraison
            </label>
            <input
              id="deliveryDate"
              name="deliveryDate"
              type="date"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label htmlFor="cost" className="block text-sm font-medium text-cool-700">
              Coût (DZD)
            </label>
            <input
              id="cost"
              name="cost"
              type="number"
              step="0.01"
              min="0"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
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
          {pending ? "Création..." : "Créer la commande"}
        </button>
        <Link
          href="/prostheses"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
