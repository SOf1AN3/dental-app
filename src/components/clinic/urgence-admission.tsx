"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { searchPatients } from "@/lib/actions/patient";
import { addWalkInToWaitingRoom } from "@/lib/actions/waiting-room";

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * SA-1: Urgence admission — search for an existing patient and add them
 * directly to the waiting room without creating an appointment.
 */
export function UrgenceAdmission() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selected, setSelected] = useState<PatientResult | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (query.length < 2) { setResults([]); return; }
      const patients = await searchPatients(query);
      setResults(patients);
      setOpen(true);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleAdmit() {
    if (!selected) return;
    setPending(true);
    setError(null);
    const result = await addWalkInToWaitingRoom(selected.id);
    if (result?.error) {
      setError(result.error);
      setPending(false);
    } else {
      router.refresh();
      setSelected(null);
      setQuery("");
      setPending(false);
    }
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700 uppercase tracking-wider">
          Urgence
        </span>
        <p className="text-sm text-red-700">Admettre un patient sans rendez-vous</p>
      </div>

      <div ref={containerRef} className="relative">
        <input
          type="text"
          placeholder="Rechercher un patient..."
          value={selected ? `${selected.lastName} ${selected.firstName}` : query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
            setError(null);
          }}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          className="block w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
        />
        {open && results.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white shadow-lg max-h-48 overflow-y-auto">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { setSelected(p); setOpen(false); setQuery(""); }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-cool-50 transition-colors"
                >
                  {p.lastName} {p.firstName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}

      <button
        type="button"
        onClick={handleAdmit}
        disabled={!selected || pending}
        className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "Admission…" : "Admettre en urgence"}
      </button>
    </div>
  );
}
