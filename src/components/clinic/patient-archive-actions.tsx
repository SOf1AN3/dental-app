"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";
import { deletePatient, restorePatient } from "@/lib/actions/patient";
import { Archive, ArchiveRestore, AlertTriangle } from "lucide-react";

export function PatientArchiveActions({
  patientId,
  archived,
}: {
  patientId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleArchive() {
    setError(null);
    startTransition(async () => {
      const result = await deletePatient(patientId);
      if ("error" in result) {
        setError(result.error);
        setShowConfirm(false);
        return;
      }
      router.refresh();
    });
  }

  function handleRestore() {
    setError(null);
    startTransition(async () => {
      const result = await restorePatient(patientId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (archived) {
    return (
      <button
        type="button"
        onClick={handleRestore}
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors disabled:opacity-50"
      >
        <ArchiveRestore className="h-4 w-4" />
        {isPending ? "..." : "Restaurer"}
      </button>
    );
  }

  if (!showConfirm) {
    return (
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-danger/30 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5 transition-colors"
      >
        <Archive className="h-4 w-4" />
        Supprimer
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 p-2">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
      <div className="flex-1">
        <p className="text-xs font-medium text-amber-800">Archiver ce patient ?</p>
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>
      <button
        type="button"
        onClick={handleArchive}
        disabled={isPending}
        className="rounded bg-danger px-2 py-1 text-xs font-medium text-white hover:bg-danger/80 disabled:opacity-50"
      >
        {isPending ? "..." : "Confirmer"}
      </button>
      <button
        type="button"
        onClick={() => {
          setShowConfirm(false);
          setError(null);
        }}
        className="rounded px-2 py-1 text-xs font-medium text-cool-500 hover:bg-cool-100 transition-colors"
      >
        Annuler
      </button>
    </div>
  );
}
