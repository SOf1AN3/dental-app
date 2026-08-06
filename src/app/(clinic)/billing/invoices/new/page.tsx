import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { InvoiceForm } from "@/components/clinic/invoice-form";

export default async function NewInvoicePage() {
  await requireAuth();
  const catalog = await getTreatmentCatalog();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Nouvelle facture</h1>
        <p className="text-sm text-cool-500">
          Créer une nouvelle facture pour un patient
        </p>
      </div>
      <InvoiceForm catalog={catalog} />
    </div>
  );
}
