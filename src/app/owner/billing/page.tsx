import { requirePlatformOwner } from "@/lib/auth-utils";
import { getBillingData } from "@/lib/actions/owner";
import { PageHeader } from "@/components/ui/page-header";
import { BillingTable } from "@/components/owner/billing-table";

export default async function OwnerBillingPage() {
  await requirePlatformOwner();
  const billingData = await getBillingData();

  return (
    <div>
      <PageHeader
        title="Facturation plateforme"
        description={`${billingData.length} abonnements`}
      />

      <BillingTable data={billingData} />
    </div>
  );
}
