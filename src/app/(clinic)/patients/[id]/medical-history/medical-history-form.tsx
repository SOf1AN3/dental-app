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
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Ajouter un antécédent
        </h2>

        <div>
          <label
            htmlFor="condition"
            className="block text-sm font-medium text-cool-700"
          >
            Condition *
          </label>
          <input
            id="condition"
            name="condition"
            type="text"
            placeholder="Ex: Diabète, Hypertension, Allergie..."
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {state?.error?.condition && (
            <p className="mt-1 text-xs text-red-500">
              {state.error.condition[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="diagnosisDate"
            className="block text-sm font-medium text-cool-700"
          >
            Date de diagnostic
          </label>
          <input
            id="diagnosisDate"
            name="diagnosisDate"
            type="date"
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {state?.error?.diagnosisDate && (
            <p className="mt-1 text-xs text-red-500">
              {state.error.diagnosisDate[0]}
            </p>
          )}
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
            placeholder="Informations complémentaires..."
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {state?.error?.notes && (
            <p className="mt-1 text-xs text-red-500">
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
            className="h-4 w-4 rounded border-cool-300 text-cerulean focus:ring-cerulean"
          />
          <span className="text-sm font-medium text-cool-700">Actif</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
      >
        {pending ? "Ajout en cours..." : "Ajouter"}
      </button>
    </form>
  );
}
