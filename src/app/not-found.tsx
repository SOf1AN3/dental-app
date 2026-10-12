import Link from "next/link";
import { SearchX } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4">
      <EmptyState
        icon={SearchX}
        title="Page non trouvée"
        description="Erreur 404 — la page que vous cherchez n'existe pas ou a été déplacée."
        action={
          <Link
            href="/"
            className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            Retour à l&apos;accueil
          </Link>
        }
      />
    </div>
  );
}
