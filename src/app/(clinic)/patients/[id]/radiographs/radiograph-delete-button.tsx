"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";
import { deleteRadiograph } from "@/lib/actions/clinical";
import { Trash2 } from "lucide-react";

export function RadiographDeleteButton({
  radiographId,
}: {
  radiographId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteRadiograph(radiographId);
      if ("error" in result) {
        setError(result.error ?? "Erreur lors de la suppression");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5 transition-colors disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {isPending ? "Suppression..." : "Supprimer"}
      </button>
    </div>
  );
}
