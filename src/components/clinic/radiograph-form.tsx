"use client";

import { useActionState } from "react";
import { createRadiograph } from "@/lib/actions/clinical";

interface RadiographFormProps {
  patientId: string;
}

export function RadiographForm({ patientId }: RadiographFormProps) {
  const [state, action, pending] = useActionState(
    createRadiograph.bind(null, patientId),
    undefined,
  );

  const fileError =
    state?.error && "file" in state.error ? state.error.file : undefined;
  const otherErrors =
    state?.error && !("file" in state.error) ? state.error : undefined;

  return (
    <form action={action} className="space-y-4">
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Ajouter une radiographie
        </h2>

        <div>
          <label htmlFor="file" className="block text-sm font-medium text-foreground">
            Fichier *
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            required
            className="mt-1 block w-full text-sm text-foreground file:mr-4 file:rounded-lg file:border-0 file:bg-cerulean/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-cerulean hover:file:bg-cerulean/20 transition-colors"
          />
          {fileError && (
            <p className="mt-1 text-xs text-destructive">{fileError[0]}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="fileType" className="block text-sm font-medium text-foreground">
              Type de fichier
            </label>
            <input
              id="fileType"
              name="fileType"
              type="text"
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
          <div>
            <label htmlFor="toothNumber" className="block text-sm font-medium text-foreground">
              Dent
            </label>
            <input
              id="toothNumber"
              name="toothNumber"
              type="number"
              min={1}
              max={32}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="region" className="block text-sm font-medium text-foreground">
            Région
          </label>
          <input
            id="region"
            name="region"
            type="text"
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-foreground">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        <div>
          <label htmlFor="takenAt" className="block text-sm font-medium text-foreground">
            Date de prise
          </label>
          <input
            id="takenAt"
            name="takenAt"
            type="date"
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        {otherErrors && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {Object.entries(otherErrors).map(([field, msgs]) => (
              <p key={field}>
                {field}: {Array.isArray(msgs) ? msgs.join(", ") : msgs}
              </p>
            ))}
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {pending ? "Enregistrement..." : "Enregistrer la radiographie"}
      </button>
    </form>
  );
}
