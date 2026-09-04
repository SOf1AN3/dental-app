import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { PrescriptionEditor } from "@/components/clinic/prescription-editor";
import { buildA5Template } from "@/lib/document-branding";
import { resolveStoredUrl } from "@/lib/storage";
import Link from "next/link";

export default async function NewPrescriptionPage() {
  await requireAuth();
  await getCurrentClinicId();

  const [clinic, profile] = await Promise.all([
    getCurrentClinic(),
    getCurrentUserProfile(),
  ]);

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const clinicTemplate = buildA5Template(clinic, { logoUrl, headerUrl });

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/prescriptions"
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour aux ordonnances
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">Nouvelle ordonnance</h1>
      </div>
      <PrescriptionEditor
        clinicTemplate={clinicTemplate}
        dentistName={profile?.name ?? null}
      />
    </div>
  );
}