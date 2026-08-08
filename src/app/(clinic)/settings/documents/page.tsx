import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinic } from "@/lib/actions/settings";
import { resolveStoredUrl } from "@/lib/storage";
import { DocumentBrandingForm } from "@/components/clinic/document-branding-form";
import { A5TemplateSettings } from "@/components/clinic/a5-template-settings";

export default async function DocumentsSettingsPage() {
  await requireAuth();

  const clinic = await getCurrentClinic();

  if (!clinic) {
    return (
      <p className="text-sm text-red-500">
        Clinique introuvable.
      </p>
    );
  }

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic.logoUrl),
    resolveStoredUrl(clinic.headerUrl),
  ]);

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Apparence des documents
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Ces éléments apparaissent sur l&apos;ordonnance, la facture et le devis.
        </p>
        <DocumentBrandingForm
          defaultValues={{
            logoUrl,
            headerUrl,
            legalInfo: clinic.legalInfo,
          }}
        />
      </section>

      <section className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Modèle d&apos;ordonnance A5
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Logo, en-tête et filigrane utilisés sur les ordonnances A5.
        </p>
        <A5TemplateSettings
          defaultValues={{
            name: clinic.name,
            address: clinic.address,
            phone: clinic.phone,
            email: clinic.email,
            legalInfo: clinic.legalInfo,
            logoUrl,
            headerUrl,
            watermarkEnabled: clinic.watermarkEnabled,
          }}
        />
      </section>
    </div>
  );
}
