import { requirePlatformOwner } from "@/lib/auth-utils";
import { getOwnerStats } from "@/lib/actions/owner";
import { Building2, CircleDollarSign, ClipboardList, Ticket } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatCards } from "@/components/clinic/dashboard/stat-cards";

export default async function OwnerDashboard() {
  await requirePlatformOwner();
  const stats = await getOwnerStats();

  return (
    <div>
      <PageHeader
        title="Console propriétaire"
        description="Gérez votre plateforme DentalCare."
      />

      <StatCards
        stats={[
          {
            label: "Cliniques actives",
            value: String(stats.activeClinics),
            color: "bg-cerulean",
            icon: Building2,
          },
          {
            label: "Revenu mensuel",
            value: `${stats.monthlyRevenue.toLocaleString("fr-DZ")} DZD`,
            color: "bg-mint",
            icon: CircleDollarSign,
          },
          {
            label: "Abonnements actifs",
            value: String(stats.activeSubscriptions),
            color: "bg-teal",
            icon: ClipboardList,
          },
          {
            label: "Tickets ouverts",
            value: String(stats.openTickets),
            color: "bg-amber",
            icon: Ticket,
          },
        ]}
      />
    </div>
  );
}
