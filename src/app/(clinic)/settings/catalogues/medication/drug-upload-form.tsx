"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import { uploadDrugCatalogExcel } from "@/lib/actions/drug-catalog";
import { Upload, X } from "lucide-react";

export function DrugUploadForm() {
  const [state, formAction, pending] = useActionState(uploadDrugCatalogExcel, undefined);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const errors = (state?.errors ?? []) as string[];

  return (
    <details className="relative">
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        <Upload className="h-4 w-4" />
        Importer Excel
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border border-border-card bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Importer un fichier Excel</h3>
        </div>

        <p className="mb-4 text-xs text-muted-fg">
          Format .xlsx. Colonnes acceptées : <strong>Nom*</strong>, <strong>Dosage</strong>,{" "}
          <strong>Forme</strong>, <strong>Catégorie</strong>, <strong>Fréquence</strong>,{" "}
          <strong>Instructions</strong>. Les médicaments existants (même nom) seront mis à jour.
        </p>

        <form action={formAction} className="space-y-4">
          <label
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border-card bg-transparent px-4 py-6 text-center hover:border-cerulean"
          >
            <input
              ref={fileInputRef}
              type="file"
              name="file"
              accept=".xlsx"
              className="hidden"
              required
              onChange={(e) => {
                const f = e.target.files?.[0];
                setFileName(f ? f.name : null);
              }}
            />
            <Upload className="mb-2 h-6 w-6 text-muted-fg" />
            <span className="text-sm text-muted-fg">
              {fileName || "Cliquez pour choisir un fichier"}
            </span>
          </label>

          {errors.length > 0 && (
            <div className="rounded-lg border border-destructive bg-red-50 p-3 text-xs text-destructive">
              <p className="mb-1 font-medium">Erreur(s) :</p>
              <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {state?.success === true && state.imported ? (
            <p className="text-sm text-green-600">
              {state.imported} médicament(s) importé(s) avec succès.
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              {pending ? "Import..." : "Importer"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFileName(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="rounded-lg border border-border-input px-3 py-2 text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              aria-label="Effacer le fichier"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
