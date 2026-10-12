import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { getCurrentClinic } from "@/lib/actions/settings";
import { buildA5Template } from "@/lib/document-branding";
import { resolveStoredUrl } from "@/lib/storage";
import { InvoiceForm } from "@/components/clinic/invoice-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewInvoicePage() {
  await requireAuth();
  const [catalog, clinic] = await Promise.all([
    getTreatmentCatalog(),
    getCurrentClinic(),
  ]);

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const clinicTemplate = buildA5Template(clinic, { logoUrl, headerUrl });

  return (
    <div>
      <PageHeader
        title="Nouvelle facture"
        description="Créer une nouvelle facture pour un patient"
      />
      <InvoiceForm
        catalog={catalog}
        defaultTaxRate={clinic?.defaultTaxRate ?? 19}
        clinicTemplate={clinicTemplate}
      />
    </div>
  );
}
