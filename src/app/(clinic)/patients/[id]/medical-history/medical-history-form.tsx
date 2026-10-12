"use client";

import { useActionState } from "react";
import { createMedicalHistoryEntry } from "@/lib/actions/clinical";

interface MedicalHistoryFormProps {
  patientId: string;
}

export function MedicalHistoryForm({ patientId }: MedicalHistoryFormProps) {
  const [state, action, pending] = useActionState(
    createMedicalHistoryEntry.bind(null, patientId),
    undefined,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Ajouter un antécédent
        </h2>

        <div>
          <label
            htmlFor="condition"
            className="block text-sm font-medium text-foreground"
          >
            Condition *
          </label>
          <input
            id="condition"
            name="condition"
            type="text"
            placeholder="Ex: Diabète, Hypertension, Allergie..."
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {state?.error?.condition && (
            <p className="mt-1 text-xs text-destructive">
              {state.error.condition[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="diagnosisDate"
            className="block text-sm font-medium text-foreground"
          >
            Date de diagnostic
          </label>
          <input
            id="diagnosisDate"
            name="diagnosisDate"
            type="date"
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {state?.error?.diagnosisDate && (
            <p className="mt-1 text-xs text-destructive">
              {state.error.diagnosisDate[0]}
            </p>
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
            placeholder="Informations complémentaires..."
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {state?.error?.notes && (
            <p className="mt-1 text-xs text-destructive">
              {state.error.notes[0]}
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            id="isActive"
            name="isActive"
            type="checkbox"
            defaultChecked
            className="h-4 w-4 rounded border-input text-primary focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
          />
          <span className="text-sm font-medium text-foreground">Actif</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {pending ? "Ajout en cours..." : "Ajouter"}
      </button>
    </form>
  );
}
