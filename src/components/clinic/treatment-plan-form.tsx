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
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Nouveau plan de traitement
        </h2>

        <div>
          <label
            htmlFor="title"
            className="block text-sm font-medium text-foreground"
          >
            Titre *
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {fieldErrors?.title && (
            <p className="mt-1 text-xs text-destructive">
              {fieldErrors.title[0]}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-foreground"
          >
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {fieldErrors?.description && (
            <p className="mt-1 text-xs text-destructive">
              {fieldErrors.description[0]}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending
            ? "Création en cours..."
            : "Créer le plan de traitement"}
        </button>
        <Link
          href={`/patients/${patientId}/treatment-plan`}
          className="rounded-lg border border-border-input px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
