import { requirePlatformOwner } from "@/lib/auth-utils";
import { getOwnerStats } from "@/lib/actions/owner";
import { LayoutDashboard } from "lucide-react";

export default async function OwnerDashboard() {
  await requirePlatformOwner();
  const stats = await getOwnerStats();

  const statCards = [
    { label: "Cliniques actives", value: String(stats.activeClinics), color: "bg-cerulean" },
    { label: "Revenu mensuel", value: `${stats.monthlyRevenue.toLocaleString("fr-DZ")} DZD`, color: "bg-mint" },
    { label: "Abonnements actifs", value: String(stats.activeSubscriptions), color: "bg-teal" },
    { label: "Tickets ouverts", value: String(stats.openTickets), color: "bg-amber" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-cool-900">Console propriétaire</h1>
      <p className="mt-1 text-cool-500">Gérez votre plateforme DentalCare.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="rounded-xl bg-white dark:bg-cool-100 p-6 shadow-sm border border-cool-100">
            <div className={`inline-flex rounded-lg ${stat.color} p-3 text-white`}>
              <LayoutDashboard className="h-6 w-6" />
            </div>
            <p className="mt-4 text-2xl font-bold text-cool-900">{stat.value}</p>
            <p className="text-sm text-cool-500">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
