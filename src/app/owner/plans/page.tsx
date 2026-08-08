import { requirePlatformOwner } from "@/lib/auth-utils";
import { getSubscriptionPlans, createSubscriptionPlan } from "@/lib/actions/owner";
import { PlanActions } from "@/components/owner/plan-actions";

async function createPlan(formData: FormData) {
  "use server";
  await createSubscriptionPlan(undefined, formData);
}

export default async function OwnerPlansPage() {
  await requirePlatformOwner();
  const plans = await getSubscriptionPlans();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Plans d&apos;abonnement</h1>
          <p className="text-sm text-cool-500">{plans.length} plans</p>
        </div>
      </div>

      <div className="mb-8 rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <h2 className="text-lg font-semibold text-cool-900 mb-4">Nouveau plan</h2>
        <form action={createPlan} className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-cool-700">Nom</label>
            <input id="name" name="name" type="text" required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div>
            <label htmlFor="code" className="block text-sm font-medium text-cool-700">Code</label>
            <input id="code" name="code" type="text" required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div>
            <label htmlFor="priceMonthly" className="block text-sm font-medium text-cool-700">Prix mensuel (DA)</label>
            <input id="priceMonthly" name="priceMonthly" type="number" required step="0.01"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div>
            <label htmlFor="priceYearly" className="block text-sm font-medium text-cool-700">Prix annuel (DA)</label>
            <input id="priceYearly" name="priceYearly" type="number" step="0.01"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div>
            <label htmlFor="maxStaff" className="block text-sm font-medium text-cool-700">Max personnel</label>
            <input id="maxStaff" name="maxStaff" type="number"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div>
            <label htmlFor="maxPatients" className="block text-sm font-medium text-cool-700">Max patients</label>
            <input id="maxPatients" name="maxPatients" type="number"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
          </div>
          <div className="col-span-2">
            <button type="submit"
              className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light transition-colors">
              Créer le plan
            </button>
          </div>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Nom</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Code</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Mensuel</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Annuel</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actif</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id} className="border-b border-cool-100 hover:bg-cool-50">
                <td className="px-4 py-3 font-medium text-cool-900">{plan.name}</td>
                <td className="px-4 py-3 text-cool-600">{plan.code}</td>
                <td className="px-4 py-3 text-cool-600">{plan.priceMonthly.toLocaleString("fr-DZ")} DZD</td>
                <td className="px-4 py-3 text-cool-600">{plan.priceYearly ? `${plan.priceYearly.toLocaleString("fr-DZ")} DZD` : "-"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    plan.isActive ? "bg-mint/10 text-mint" : "bg-cool-100 text-cool-500"
                  }`}>
                    {plan.isActive ? "Oui" : "Non"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <PlanActions plan={plan} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
