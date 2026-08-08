"use client";

import { useActionState } from "react";
import { createConsultationNote } from "@/lib/actions/clinical";

interface ConsultationNoteFormProps {
  patientId: string;
}

export function ConsultationNoteForm({ patientId }: ConsultationNoteFormProps) {
  const [state, action, pending] = useActionState(
    createConsultationNote.bind(null, patientId),
    undefined,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Ajouter une note
        </h2>

        <div>
          <label
            htmlFor="diagnosis"
            className="block text-sm font-medium text-cool-700"
          >
            Diagnostic
          </label>
          <input
            id="diagnosis"
            name="diagnosis"
            type="text"
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {state?.error?.diagnosis && (
            <p className="mt-1 text-xs text-red-500">
              {state.error.diagnosis[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-cool-700"
          >
            Notes *
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {state?.error?.notes && (
            <p className="mt-1 text-xs text-red-500">
              {state.error.notes[0]}
            </p>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
      >
        {pending ? "Ajout en cours..." : "Ajouter une note"}
      </button>
    </form>
  );
}
