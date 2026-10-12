import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { getCurrentClinic } from "@/lib/actions/settings";
import { buildA5Template } from "@/lib/document-branding";
import { resolveStoredUrl } from "@/lib/storage";
import { QuoteForm } from "@/components/clinic/quote-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewQuotePage() {
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
        title="Nouveau devis"
        description="Créer un nouveau devis pour un patient"
      />
      <QuoteForm
        catalog={catalog}
        defaultTaxRate={clinic?.defaultTaxRate ?? 19}
        clinicTemplate={clinicTemplate}
      />
    </div>
  );
}
