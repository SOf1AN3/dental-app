import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getStockItem } from "@/lib/actions/inventory";
import { StockItemForm } from "@/components/clinic/stock-item-form";
import { notFound } from "next/navigation";

export default async function EditStockItemPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const item = await getStockItem(id);

  if (!item) {
    notFound();
  }

  return (
    <StockItemForm
      itemId={id}
      defaultValues={{
        name: item.name,
        category: item.category,
        description: item.description,
        currentQty: item.currentQty,
        minQty: item.minQty,
        unit: item.unit,
        supplierId: item.supplierId,
        purchasePrice: item.purchasePrice,
        sellingPrice: item.sellingPrice,
      }}
    />
  );
}
