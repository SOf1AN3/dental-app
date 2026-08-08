"use client";

import { cn } from "@/lib/utils";

interface ProsthesisStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  ordered: "Commandée",
  in_progress: "En cours",
  delivered: "Livrée",
  cancelled: "Annulée",
};

const statusColors: Record<string, string> = {
  ordered: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  in_progress: "bg-cerulean/10 text-cerulean",
  delivered: "bg-mint/10 text-mint",
  cancelled: "bg-cool-100 text-cool-500",
};

export function ProsthesisStatusBadge({ status, className }: ProsthesisStatusBadgeProps) {
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
