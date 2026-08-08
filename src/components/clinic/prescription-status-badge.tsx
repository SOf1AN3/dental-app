"use client";

import { cn } from "@/lib/utils";

interface PrescriptionStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  active: "Active",
  completed: "Complétée",
  cancelled: "Annulée",
};

const statusColors: Record<string, string> = {
  active: "bg-mint/10 text-mint",
  completed: "bg-cool-100 text-cool-500",
  cancelled: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
};

export function PrescriptionStatusBadge({ status, className }: PrescriptionStatusBadgeProps) {
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
