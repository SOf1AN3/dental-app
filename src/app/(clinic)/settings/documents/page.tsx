import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinic } from "@/lib/actions/settings";
import { resolveStoredUrl } from "@/lib/storage";
import { resolveBranding } from "@/lib/document-branding";
import { DocumentBrandingForm } from "@/components/clinic/document-branding-form";
import { A5TemplateSettings } from "@/components/clinic/a5-template-settings";

export default async function DocumentsSettingsPage() {
  await requireAuth();

  const clinic = await getCurrentClinic();

  if (!clinic) {
    return (
      <p className="text-sm text-destructive">
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
      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Logo et en-tête
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Logo, en-tête et mentions légales utilisés sur l&apos;ordonnance, la facture
          et le devis.
        </p>
        <DocumentBrandingForm
          defaultValues={{
            logoUrl,
            headerUrl,
            legalInfo: clinic.legalInfo,
          }}
        />
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Modèle des documents A5
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Choisissez le modèle, les couleurs, le sous-titre et le pied de page appliqués
          à l&apos;ordonnance, la facture et le devis.
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
            branding: resolveBranding(clinic.documentBranding),
          }}
        />
      </section>
    </div>
  );
}
