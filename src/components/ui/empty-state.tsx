import type { ReactNode } from "react";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** Icône lucide à afficher (ex: Users, Calendar, Receipt) */
  icon: LucideIcon;
  /** Titre principal de l'état vide */
  title: string;
  /** Description optionnelle, aide l'utilisateur à comprendre pourquoi c'est vide */
  description?: ReactNode;
  /** Slot d'action optionnel : CTA vers la création (ex: bouton « Nouveau patient ») */
  action?: ReactNode;
  /** Classes additionnelles sur le conteneur racine */
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-cool-100 text-cool-500 dark:bg-cool-200 dark:text-cool-600">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm font-medium text-cool-900 dark:text-cool-900">{title}</p>
        {description ? (
          <p className="max-w-sm text-sm text-muted-fg">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
