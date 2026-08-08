"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteSession } from "@/lib/actions/session";

export function DeleteSessionButton({
  sessionId,
  patientId,
}: {
  sessionId: string;
  patientId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (
      !window.confirm(
        "Supprimer cette séance ? Tous les actes seront perdus. Cette action est irréversible.",
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await deleteSession(sessionId);
    if (result && "success" in result) {
      router.push(`/patients/${patientId}/sessions`);
      return;
    }
    if (result && "error" in result) {
      setError(result.error ?? null);
    }
    setPending(false);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleDelete}
        disabled={pending}
        className="rounded-lg border border-danger/30 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5 transition-colors disabled:opacity-50"
      >
        {pending ? "Suppression..." : "Supprimer la séance"}
      </button>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
