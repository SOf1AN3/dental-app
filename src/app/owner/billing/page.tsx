import { requirePlatformOwner } from "@/lib/auth-utils";
import { getBillingData } from "@/lib/actions/owner";
import { formatDate } from "@/lib/utils";

export default async function OwnerBillingPage() {
  await requirePlatformOwner();
  const billingData = await getBillingData();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Facturation plateforme</h1>
        <p className="text-sm text-cool-500">{billingData.length} abonnements</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Clinique</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Plan</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Début</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Fin</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Statut</th>
            </tr>
          </thead>
          <tbody>
            {billingData.map((item) => (
              <tr key={item.id} className="border-b border-cool-100 hover:bg-cool-50">
                <td className="px-4 py-3 font-medium text-cool-900">{item.clinicName}</td>
                <td className="px-4 py-3 text-cool-600">{item.planName}</td>
                <td className="px-4 py-3 text-cool-600">{formatDate(item.startDate)}</td>
                <td className="px-4 py-3 text-cool-600">{item.endDate ? formatDate(item.endDate) : "-"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    item.status === "active" ? "bg-mint/10 text-mint" :
                    item.status === "trial" ? "bg-amber/10 text-amber-fg" :
                    "bg-cool-100 text-cool-500"
                  }`}>
                    {item.status === "active" ? "Actif" : item.status === "trial" ? "Essai" : item.status}
                  </span>
                </td>
              </tr>
            ))}
            {billingData.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-cool-400">
                  Aucune donnée de facturation
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
