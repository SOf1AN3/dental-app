import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

const statusColors: Record<string, string> = {
  active: "bg-mint/10 text-mint border-mint/20",
  completed: "bg-mint/10 text-mint border-mint/20",
  paid: "bg-mint/10 text-mint border-mint/20",
  scheduled: "bg-cerulean/10 text-cerulean border-cerulean/20",
  confirmed: "bg-cerulean/10 text-cerulean border-cerulean/20",
  draft: "bg-cool-100 text-cool-600 border-cool-200",
  pending: "bg-amber/10 text-amber border-amber/20",
  waiting: "bg-amber/10 text-amber border-amber/20",
  cancelled: "bg-danger/10 text-danger border-danger/20",
  no_show: "bg-danger/10 text-danger border-danger/20",
  in_progress: "bg-cerulean/10 text-cerulean border-cerulean/20",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const colorClass = statusColors[status] || "bg-cool-100 text-cool-600 border-cool-200";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        colorClass,
        className
      )}
    >
      {status}
    </span>
  );
}
