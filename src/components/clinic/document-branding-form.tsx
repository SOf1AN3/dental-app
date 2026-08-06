"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateDocumentBranding } from "@/lib/actions/settings";

type DefaultValues = {
  logoUrl: string | null;
  headerUrl: string | null;
  legalInfo: string | null;
};

export function DocumentBrandingForm({
  defaultValues,
}: {
  defaultValues: DefaultValues;
}) {
  const [state, action, pending] = useActionState(
    updateDocumentBranding,
    undefined
  );
  const [logoPreview, setLogoPreview] = useState<string | null>(
    defaultValues.logoUrl
  );
  const [headerPreview, setHeaderPreview] = useState<string | null>(
    defaultValues.headerUrl
  );

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? (state.error as Record<string, string[] | undefined>).general?.[0]
      : undefined;

  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-cool-700 mb-1">
          Logo de la clinique
        </label>
        {logoPreview && (
          <div className="mb-2 relative w-32 h-32 rounded-lg border border-cool-200 overflow-hidden bg-cool-50">
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img
              src={logoPreview}
              alt="Logo de la clinique"
              className="w-full h-full object-contain"
            />
          </div>
        )}
        <input
          id="logo"
          name="logo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setLogoPreview(URL.createObjectURL(file));
            }
          }}
          className="mt-1 block w-full text-sm text-cool-700 file:mr-3 file:rounded-lg file:border-0 file:bg-cerulean/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-cerulean hover:file:bg-cerulean/20"
        />
        <p className="mt-1 text-xs text-cool-400">
          Formats acceptés : JPG, PNG, WebP. Taille max : 10 Mo.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-cool-700 mb-1">
          En-tête des documents
        </label>
        {headerPreview && (
          <div className="mb-2 relative w-full h-24 rounded-lg border border-cool-200 overflow-hidden bg-cool-50">
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img
              src={headerPreview}
              alt="En-tête de la clinique"
              className="w-full h-full object-contain object-left"
            />
          </div>
        )}
        <input
          id="header"
          name="header"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setHeaderPreview(URL.createObjectURL(file));
            }
          }}
          className="mt-1 block w-full text-sm text-cool-700 file:mr-3 file:rounded-lg file:border-0 file:bg-cerulean/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-cerulean hover:file:bg-cerulean/20"
        />
        <p className="mt-1 text-xs text-cool-400">
          Formats acceptés : JPG, PNG, WebP. Taille max : 10 Mo.
        </p>
      </div>

      <div>
        <label
          htmlFor="legalInfo"
          className="block text-sm font-medium text-cool-700"
        >
          Mentions légales
        </label>
        <textarea
          id="legalInfo"
          name="legalInfo"
          rows={4}
          defaultValue={defaultValues.legalInfo ?? ""}
          placeholder="SIRET, RC, NIF, numéro d'agrément..."
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean resize-y"
        />
        <p className="mt-1 text-xs text-cool-400">
          Ces informations apparaîtront sur les documents (devis, factures, etc.).
        </p>
      </div>

      {generalError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {generalError}
        </div>
      )}

      {state?.success && (
        <p className="text-sm text-green-600">
          Apparence des documents mise à jour.
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Enregistrement..." : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
