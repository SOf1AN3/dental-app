import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { OrderForm } from "@/components/clinic/order-form";

export default async function NewOrderPage() {
  await requireAuth();
  await getCurrentClinicId();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-cool-900">Nouvelle commande</h1>
      <OrderForm />
    </div>
  );
}
