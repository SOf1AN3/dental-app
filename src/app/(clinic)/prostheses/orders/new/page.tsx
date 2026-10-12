import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { OrderForm } from "@/components/clinic/order-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewOrderPage() {
  await requireAuth();
  await getCurrentClinicId();

  return (
    <div>
      <PageHeader title="Nouvelle commande" />
      <OrderForm />
    </div>
  );
}
