"use client";

import { cn } from "@/lib/utils";

interface SessionStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  pending: "En attente",
  in_progress: "En cours",
  completed: "Terminée",
  invoiced: "Facturée",
  paid: "Payée",
};

const statusColors: Record<string, string> = {
  pending: "bg-amber/10 text-amber-fg",
  in_progress: "bg-cerulean/10 text-cerulean",
  completed: "bg-cool-100 text-cool-600",
  invoiced: "bg-primary/10 text-primary",
  paid: "bg-mint/10 text-mint",
};

export function SessionStatusBadge({
  status,
  className,
}: SessionStatusBadgeProps) {
  const label = statusLabels[status] || status;
  const colorClass = statusColors[status] || "bg-cool-100 text-cool-600";

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
