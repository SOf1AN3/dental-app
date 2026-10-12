import type { LucideIcon } from "lucide-react";

export interface StatCardData {
  label: string;
  value: string;
  color: string;
  /** Icône distincte par métrique — c'est elle qui rend la carte identifiable */
  icon: LucideIcon;
}

export function StatCards({ stats }: { stats: StatCardData[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="rounded-xl bg-card p-6 shadow-sm border border-border-card"
          >
            <div
              aria-hidden="true"
              className={`inline-flex rounded-lg ${stat.color} p-3 text-white`}
            >
              <Icon className="size-5" aria-hidden="true" />
            </div>
            <p className="mt-4 text-2xl font-bold text-cool-900">{stat.value}</p>
            <p className="text-sm text-muted-fg">{stat.label}</p>
          </div>
        );
      })}
    </div>
  );
}
