"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createTreatmentPlan } from "@/lib/actions/clinical";

interface TreatmentPlanFormProps {
  patientId: string;
}

export function TreatmentPlanForm({ patientId }: TreatmentPlanFormProps) {
  const [state, action, pending] = useActionState(
    createTreatmentPlan.bind(null, patientId),
    undefined,
  );

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Nouveau plan de traitement
        </h2>

        <div>
          <label
            htmlFor="title"
            className="block text-sm font-medium text-cool-700"
          >
            Titre *
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {fieldErrors?.title && (
            <p className="mt-1 text-xs text-red-500">
              {fieldErrors.title[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-cool-700"
          >
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {fieldErrors?.description && (
            <p className="mt-1 text-xs text-red-500">
              {fieldErrors.description[0]}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending
            ? "Création en cours..."
            : "Créer le plan de traitement"}
        </button>
        <Link
          href={`/patients/${patientId}/treatment-plan`}
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
