"use client";

import { useState } from "react";
import { Download } from "lucide-react";

export function ClinicExportPicker({
  clinics,
}: {
  clinics: { id: string; name: string }[];
}) {
  const [clinicId, setClinicId] = useState("");

  const isReady = clinicId.length > 0;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label
          htmlFor="clinic-export-select"
          className="block text-sm font-medium text-foreground"
        >
          Clinique
        </label>
        <select
          id="clinic-export-select"
          value={clinicId}
          onChange={(e) => setClinicId(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        >
          <option value="">Sélectionner une clinique…</option>
          {clinics.map((clinic) => (
            <option key={clinic.id} value={clinic.id}>
              {clinic.name}
            </option>
          ))}
        </select>
      </div>
      <a
        href={isReady ? `/api/owner/export?clinicId=${encodeURIComponent(clinicId)}` : undefined}
        aria-disabled={!isReady}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          isReady
            ? "bg-cerulean text-white hover:bg-cerulean-dark"
            : "cursor-not-allowed bg-cool-100 text-cool-400"
        }`}
      >
        <Download className="h-4 w-4" />
        Télécharger
      </a>
    </div>
  );
}
