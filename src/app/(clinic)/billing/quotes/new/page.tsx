import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { getCurrentClinic } from "@/lib/actions/settings";
import { buildA5Template } from "@/lib/document-branding";
import { resolveStoredUrl } from "@/lib/storage";
import { QuoteForm } from "@/components/clinic/quote-form";

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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Nouveau devis</h1>
        <p className="text-sm text-cool-500">
          Créer un nouveau devis pour un patient
        </p>
      </div>
      <QuoteForm
        catalog={catalog}
        defaultTaxRate={clinic?.defaultTaxRate ?? 19}
        clinicTemplate={clinicTemplate}
      />
    </div>
  );
}
