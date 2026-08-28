import { LayoutDashboard } from "lucide-react";

export interface StatCardData {
  label: string;
  value: string;
  color: string;
}

export function StatCards({ stats }: { stats: StatCardData[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
          <div className={`inline-flex rounded-lg ${stat.color} p-3 text-white`}>
            <LayoutDashboard className="h-6 w-6" />
          </div>
          <p className="mt-4 text-2xl font-bold text-cool-900">{stat.value}</p>
          <p className="text-sm text-cool-500">{stat.label}</p>
        </div>
      ))}
    </div>
  );
}
