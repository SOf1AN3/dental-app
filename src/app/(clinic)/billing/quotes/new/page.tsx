import { requireAuth } from "@/lib/auth-utils";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { QuoteForm } from "@/components/clinic/quote-form";

export default async function NewQuotePage() {
  await requireAuth();
  const catalog = await getTreatmentCatalog();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Nouveau devis</h1>
        <p className="text-sm text-cool-500">
          Créer un nouveau devis pour un patient
        </p>
      </div>
      <QuoteForm catalog={catalog} />
    </div>
  );
}
