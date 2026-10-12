"use client";

import { AlertTriangle } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4">
      <EmptyState
        icon={AlertTriangle}
        title="Une erreur est survenue"
        description={error.message}
        action={
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Réessayer
          </button>
        }
      />
    </div>
  );
}
