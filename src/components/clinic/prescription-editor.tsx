"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { createPrescription, updatePrescription } from "@/lib/actions/prescription";
import { searchPatients } from "@/lib/actions/patient";
import { formatDate } from "@/lib/utils";
import {
  A5Prescription,
  type A5Template,
  type A5Item,
  type A5Data,
} from "@/components/clinic/a5-prescription";
import {
  PrescriptionLineItems,
  type PrescriptionLineItem,
} from "@/components/clinic/prescription-line-items";
import {
  A5_SHEET_WIDTH_PX,
  A5_SHEET_HEIGHT_PX,
} from "@/components/clinic/a5-styles";

export interface PrescriptionEditorProps {
  clinicTemplate: A5Template;
  dentistName: string | null;
  /** Present => edit mode (binds updatePrescription with the id). */
  id?: string;
  initialData?: {
    patient: { id: string; firstName: string; lastName: string; dateOfBirth: Date | string | null };
    notes: string | null;
    items: A5Item[];
    rxNumber: string;
  };
  /** Present => the editor is used inside a clinical session (hidden field sent to the action). */
  sessionId?: string;
  /** Pre-selected patient (used instead of the patient search when fixedPatient is set). */
  patientPreset?: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: Date | string | null;
  };
  /** Disables the patient search UI and shows the selected patient read-only. */
  fixedPatient?: boolean;
}

interface PatientResult {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | string | null;
}

const inputClassName =
  "mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean";

function emptyLineItem(): PrescriptionLineItem {
  return {
    id: crypto.randomUUID(),
    type: "medication",
    name: "",
    dosage: "",
    form: "",
    frequency: "",
    duration: "",
    quantity: null,
    instructions: "",
  };
}

export function PrescriptionEditor({
  clinicTemplate,
  dentistName,
  id,
  initialData,
  sessionId,
  patientPreset,
  fixedPatient = false,
}: PrescriptionEditorProps) {
  const action = id ? updatePrescription.bind(null, id) : createPrescription;
  const [state, formAction, pending] = useActionState(action, undefined);

  const initialPatient = patientPreset ?? initialData?.patient ?? null;

  const [query, setQuery] = useState(
    initialPatient ? `${initialPatient.lastName} ${initialPatient.firstName}` : ""
  );
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selected, setSelected] = useState<PatientResult | null>(
    initialPatient
      ? {
          id: initialPatient.id,
          firstName: initialPatient.firstName,
          lastName: initialPatient.lastName,
          dateOfBirth: initialPatient.dateOfBirth ?? null,
        }
      : null
  );
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [items, setItems] = useState<PrescriptionLineItem[]>(() => {
    const initial = (initialData?.items ?? []).map((item): PrescriptionLineItem => ({
      id: crypto.randomUUID(),
      type: item.type,
      name: item.name,
      dosage: item.dosage ?? "",
      form: item.form ?? "",
      frequency: item.frequency ?? "",
      duration: item.duration ?? "",
      quantity: item.quantity ?? "",
      instructions: item.instructions ?? "",
    }));
    return initial.length > 0 ? initial : [emptyLineItem()];
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Live preview scaling (A5 sheet is 559.4 x 793.7 px at 96dpi).
  const previewRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const fieldErrors = state && "error" in state && state.error && !("general" in state.error)
    ? (state.error as Record<string, string[] | undefined>)
    : ({} as Record<string, string[] | undefined>);

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? (state.error as Record<string, string[] | undefined>).general?.[0]
      : undefined;

  const successMessage =
    state && "success" in state && state.success
      ? sessionId
        ? "Ordonnance validée"
        : id
          ? "Modifications enregistrées avec succès"
          : "Ordonnance créée avec succès"
      : null;

  const [dirty, setDirty] = useState(false);
  const showSuccess = !dirty && Boolean(successMessage);

  function handleSubmit(formData: FormData) {
    setDirty(false);
    formAction(formData);
  }

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (!query || selected) {
        setResults([]);
        setOpen(false);
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
    setDirty(true);
  }

  const scale = containerWidth > 0 ? Math.min(1, containerWidth / A5_SHEET_WIDTH_PX) : 1;

  // Empty rows (all fields empty) are kept in the editor for UX but stripped
  // from the submitted payload.
  const serializedItems = JSON.stringify(
    items
      .filter((item) => item.name.trim().length > 0)
      .map((item) => {
        const { id: _id, quantity, ...rest } = item;
        void _id;
        return {
          ...rest,
          quantity: quantity === "" || quantity == null ? null : quantity,
        };
      })
  );

  const previewData: A5Data = {
    rxNumber: initialData?.rxNumber ?? "",
    patientName: selected ? `${selected.lastName} ${selected.firstName}` : "—",
    patientBirthdate: selected?.dateOfBirth ? formatDate(selected.dateOfBirth) : null,
    patientAge: null,
    dentistName,
    date: formatDate(new Date()),
    notes: notes.trim() || null,
    items: items.map((item) => ({
      type: item.type,
      name: item.name,
      dosage: item.dosage || null,
      form: item.form || null,
      frequency: item.frequency || null,
      duration: item.duration || null,
      quantity: item.quantity === "" || item.quantity == null ? null : item.quantity,
      instructions: item.instructions || null,
    })),
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <form action={handleSubmit} className="space-y-6">
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-cool-900">
            Informations de l&apos;ordonnance
          </h2>

          {generalError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
              {generalError}
            </div>
          )}

          {showSuccess && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400">
              {successMessage}
            </div>
          )}

          {fixedPatient ? (
            <div>
              <label className="block text-sm font-medium text-cool-700">
                Patient *
              </label>
              <div className="mt-1 rounded-lg border border-cool-200 bg-cool-100 px-3 py-2 text-sm text-cool-700">
                {selected ? `${selected.lastName} ${selected.firstName}` : "—"}
              </div>
              <input type="hidden" name="patientId" value={selected?.id || ""} />
              {fieldErrors?.patientId && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.patientId[0]}</p>
              )}
            </div>
          ) : (
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
                onFocus={() => {
                  if (results.length > 0) setOpen(true);
                }}
                className={inputClassName}
              />
              <input type="hidden" name="patientId" value={selected?.id || ""} />
              {fieldErrors?.patientId && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.patientId[0]}</p>
              )}
              {open && results.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded-lg border border-cool-200 bg-white dark:bg-cool-100 shadow-lg max-h-48 overflow-y-auto">
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
          )}

          {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}

          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-cool-700">
              Notes
            </label>
            <textarea
              id="notes"
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setDirty(true);
              }}
              className={inputClassName}
            />
            <input type="hidden" name="notes" value={notes} />
          </div>

          <div>
            <label className="block text-sm font-medium text-cool-700 mb-2">
              Articles
            </label>
            <PrescriptionLineItems
              items={items}
              onChange={(next) => {
                setItems(next);
                setDirty(true);
              }}
            />
            <input type="hidden" name="items" value={serializedItems} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
          >
            {pending
              ? sessionId
                ? "Validation..."
                : id
                  ? "Enregistrement..."
                  : "Création..."
              : sessionId
                ? "Valider l'ordonnance"
                : id
                  ? "Enregistrer les modifications"
                  : "Créer l'ordonnance"}
          </button>
          {id && (
            <Link
              href={`/prescriptions/${id}`}
              className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
            >
              Voir l&apos;ordonnance
            </Link>
          )}
          <Link
            href="/prescriptions"
            className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
          >
            Annuler
          </Link>
        </div>
      </form>

      <div className="hidden lg:block lg:sticky lg:top-24 self-start">
        <p className="mb-2 text-xs font-medium text-cool-500 uppercase tracking-wider">
          Aperçu A5
        </p>
        <div ref={previewRef} className="w-full">
          <div
            className="overflow-hidden rounded-lg border border-cool-200 shadow-lg"
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
              <A5Prescription template={clinicTemplate} data={previewData} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
