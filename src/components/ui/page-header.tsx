import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** Texte du titre — rendu dans un <h1> */
  title: string;
  /** Sous-titre optionnel, rendu dans un <p> juste sous le titre */
  description?: ReactNode;
  /** Slot d'actions à droite (boutons, liens, toggles) */
  actions?: ReactNode;
  /** Classes additionnelles appliquées au conteneur racine */
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-fg">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
