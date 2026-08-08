"use client";

import { cn } from "@/lib/utils";

interface StockStatusBadgeProps {
  currentQty: number;
  minQty: number;
  className?: string;
}

export function StockStatusBadge({
  currentQty,
  minQty,
  className,
}: StockStatusBadgeProps) {
  if (currentQty <= 0) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
          className,
        )}
      >
        Rupture
      </span>
    );
  }

  if (currentQty < minQty) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
          className,
        )}
      >
        Stock bas
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium bg-mint/10 text-mint",
        className,
      )}
    >
      En stock
    </span>
  );
}
