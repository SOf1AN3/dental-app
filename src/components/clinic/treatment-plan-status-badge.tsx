"use client";

import { cn } from "@/lib/utils";

interface TreatmentPlanStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  draft: "Brouillon",
  active: "Actif",
  completed: "Terminé",
  cancelled: "Annulé",
};

const statusColors: Record<string, string> = {
  draft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  active: "bg-cerulean/10 text-cerulean",
  completed: "bg-mint/10 text-mint",
  cancelled: "bg-cool-100 text-cool-500",
};

export function TreatmentPlanStatusBadge({
  status,
  className,
}: TreatmentPlanStatusBadgeProps) {
  const label = statusLabels[status] || status;
  const colorClass =
    statusColors[status] || "bg-cool-100 text-cool-600";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium",
        colorClass,
        className,
      )}
    >
      {label}
    </span>
  );
}
