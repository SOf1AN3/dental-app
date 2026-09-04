"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

export interface DrugOption {
  id: string;
  name: string;
  dosage: string | null;
  form: string | null;
  category: string | null;
  frequency: string | null;
  instructions: string | null;
}

interface DrugAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelectDrug: (drug: DrugOption) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

export function DrugAutocomplete({
  value,
  onChange,
  onSelectDrug,
  placeholder,
  ariaLabel,
  className,
}: DrugAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const [options, setOptions] = useState<DrugOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (value !== prevValue) {
    setPrevValue(value);
    setQuery(value);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleChange(next: string) {
    setQuery(next);
    onChange(next);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    const trimmed = next.trim();
    if (trimmed.length === 0) {
      setOptions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/drugs/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as DrugOption[];
        setOptions(data);
        setOpen(true);
      } catch {
        // aborted or failed; ignore
      } finally {
        setLoading(false);
      }
    }, 300);
  }

  function handleSelect(drug: DrugOption) {
    onSelectDrug(drug);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => options.length > 0 && setOpen(true)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={className}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
          {loading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-cool-200 border-t-cerulean" />
          ) : (
            <Search className="h-4 w-4 text-cool-400" />
          )}
        </span>
      </div>

      {open && options.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-cool-200 bg-white py-1 shadow-lg"
        >
          {options.map((drug) => (
            <li key={drug.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => handleSelect(drug)}
                className="flex w-full flex-col px-3 py-2 text-left hover:bg-cool-50"
              >
                <span className="text-sm font-medium text-cool-900">
                  {drug.name}
                  {drug.dosage ? <span className="text-cool-500"> {drug.dosage}</span> : null}
                </span>
                <span className="text-xs text-cool-500">
                  {[drug.form, drug.category].filter(Boolean).join(" · ") || "\u00A0"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
