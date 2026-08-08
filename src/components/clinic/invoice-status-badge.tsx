"use client";

import { cn } from "@/lib/utils";

interface InvoiceStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  draft: "Brouillon",
  sent: "Envoyée",
  paid: "Payée",
  partially_paid: "Partielle",
  overdue: "Impayée",
  cancelled: "Annulée",
};

const statusColors: Record<string, string> = {
  draft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  sent: "bg-cerulean/10 text-cerulean",
  paid: "bg-mint/10 text-mint",
  partially_paid: "bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400",
  overdue: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
  cancelled: "bg-cool-100 text-cool-500",
};

export function InvoiceStatusBadge({
  status,
  className,
}: InvoiceStatusBadgeProps) {
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
