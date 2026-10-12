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
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Ajouter une note
        </h2>

        <div>
          <label
            htmlFor="diagnosis"
            className="block text-sm font-medium text-foreground"
          >
            Diagnostic
          </label>
          <input
            id="diagnosis"
            name="diagnosis"
            type="text"
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {state?.error?.diagnosis && (
            <p className="mt-1 text-xs text-destructive">
              {state.error.diagnosis[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-foreground"
          >
            Notes *
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            required
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {state?.error?.notes && (
            <p className="mt-1 text-xs text-destructive">
              {state.error.notes[0]}
            </p>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {pending ? "Ajout en cours..." : "Ajouter une note"}
      </button>
    </form>
  );
}
