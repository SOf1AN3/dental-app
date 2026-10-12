import { requirePlatformOwner } from "@/lib/auth-utils";
import { getSubscriptionPlans, createSubscriptionPlan } from "@/lib/actions/owner";
import { PageHeader } from "@/components/ui/page-header";
import { PlanTable } from "@/components/owner/plan-table";

async function createPlan(formData: FormData) {
  "use server";
  await createSubscriptionPlan(undefined, formData);
}

export default async function OwnerPlansPage() {
  await requirePlatformOwner();
  const plans = await getSubscriptionPlans();

  return (
    <div>
      <PageHeader
        title="Plans d'abonnement"
        description={`${plans.length} plans`}
      />

      <div className="mb-8 rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Nouveau plan</h2>
        <form action={createPlan} className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-foreground">Nom</label>
            <input id="name" name="name" type="text" required
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div>
            <label htmlFor="code" className="block text-sm font-medium text-foreground">Code</label>
            <input id="code" name="code" type="text" required
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div>
            <label htmlFor="priceMonthly" className="block text-sm font-medium text-foreground">Prix mensuel (DA)</label>
            <input id="priceMonthly" name="priceMonthly" type="number" required step="0.01"
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div>
            <label htmlFor="priceYearly" className="block text-sm font-medium text-foreground">Prix annuel (DA)</label>
            <input id="priceYearly" name="priceYearly" type="number" step="0.01"
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div>
            <label htmlFor="maxStaff" className="block text-sm font-medium text-foreground">Max personnel</label>
            <input id="maxStaff" name="maxStaff" type="number"
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div>
            <label htmlFor="maxPatients" className="block text-sm font-medium text-foreground">Max patients</label>
            <input id="maxPatients" name="maxPatients" type="number"
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          </div>
          <div className="col-span-2">
            <button type="submit"
              className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2">
              Créer le plan
            </button>
          </div>
        </form>
      </div>

      <PlanTable data={plans} />
    </div>
  );
}
