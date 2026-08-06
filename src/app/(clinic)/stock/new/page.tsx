import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { StockItemForm } from "@/components/clinic/stock-item-form";

export default async function NewStockItemPage() {
  await requireAuth();
  await getCurrentClinicId();

  return <StockItemForm />;
}
