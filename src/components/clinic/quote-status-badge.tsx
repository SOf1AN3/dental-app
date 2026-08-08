"use client";

import { cn } from "@/lib/utils";

interface QuoteStatusBadgeProps {
  status: string;
  className?: string;
}

const statusLabels: Record<string, string> = {
  draft: "Brouillon",
  sent: "Envoyé",
  accepted: "Accepté",
  rejected: "Refusé",
  expired: "Expiré",
};

const statusColors: Record<string, string> = {
  draft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  sent: "bg-cerulean/10 text-cerulean",
  accepted: "bg-mint/10 text-mint",
  rejected: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
  expired: "bg-cool-100 text-cool-500",
};

export function QuoteStatusBadge({ status, className }: QuoteStatusBadgeProps) {
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
