"use client";

import { useState } from "react";
import { toggleClinicStatus, archiveClinic, restoreClinic } from "@/lib/actions/owner";
import { AlertTriangle } from "lucide-react";

type Clinic = {
  id: string;
  name: string;
  status: string;
  deletedAt: Date | null;
};

export function ClinicActions({
  clinic,
  restorable = false,
}: {
  clinic: Clinic;
  restorable?: boolean;
}) {
  const [confirmMode, setConfirmMode] = useState<"status" | "archive" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newStatus = clinic.status === "active" ? "suspended" : "active";
  const isSuspending = clinic.status === "active";

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    const result = await toggleClinicStatus(clinic.id, newStatus as "active" | "suspended");
    if ("error" in result && result.error) {
      setError(result.error);
      setPending(false);
    }
  };

  if (clinic.deletedAt) {
    return restorable ? (
      <form action={async () => { await restoreClinic(clinic.id); }}>
        <button
          type="submit"
          className="text-sm font-medium text-mint hover:text-mint/80 transition-colors"
        >
          Restaurer
        </button>
      </form>
    ) : (
      <span className="text-xs text-cool-400">Restauration expirée</span>
    );
  }

  if (confirmMode === "archive") {
    return (
      <form action={async () => { await archiveClinic(clinic.id); }}>
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-400 p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
              Archiver {clinic.name} ?
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              className="rounded px-2 py-1 text-xs font-medium text-white bg-danger hover:bg-danger/80 transition-colors"
            >
              Confirmer
            </button>
            <button
              type="button"
              onClick={() => setConfirmMode(null)}
              className="rounded px-2 py-1 text-xs font-medium text-cool-500 hover:bg-cool-100 transition-colors"
            >
              Annuler
            </button>
          </div>
        </div>
      </form>
    );
  }

  if (confirmMode === "status") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-400 p-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
            {isSuspending
              ? `Suspendre ${clinic.name} ?`
              : `Activer ${clinic.name} ?`}
          </p>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className={`rounded px-2 py-1 text-xs font-medium text-white transition-colors ${
              isSuspending
                ? "bg-danger hover:bg-danger/80"
                : "bg-mint hover:opacity-90"
            } disabled:opacity-50`}
          >
            {pending ? "..." : "Confirmer"}
          </button>
          <button
            type="button"
            onClick={() => { setConfirmMode(null); setError(null); }}
            className="rounded px-2 py-1 text-xs font-medium text-cool-500 hover:bg-cool-100 transition-colors"
          >
            Annuler
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => setConfirmMode("status")}
        className={`text-sm font-medium transition-colors ${
          isSuspending
            ? "text-danger hover:text-danger/80"
            : "text-mint hover:text-mint/80"
        }`}
      >
        {isSuspending ? "Suspendre" : "Activer"}
      </button>
      <button
        type="button"
        onClick={() => setConfirmMode("archive")}
        className="text-sm font-medium text-danger hover:text-danger/80 transition-colors"
      >
        Archiver
      </button>
    </div>
  );
}
