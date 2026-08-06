import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { PrescriptionEditor } from "@/components/clinic/prescription-editor";
import type { A5Template } from "@/components/clinic/a5-prescription";
import { resolveStoredUrl } from "@/lib/storage";
import Link from "next/link";

const FALLBACK_TEMPLATE: A5Template = {
  name: "Cabinet Dentaire",
  address: null,
  phone: null,
  email: null,
  legalInfo: null,
  logoUrl: null,
  headerUrl: null,
  watermarkEnabled: false,
};

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

  const clinicTemplate: A5Template = clinic
    ? {
        name: clinic.name,
        address: clinic.address,
        phone: clinic.phone,
        email: clinic.email,
        legalInfo: clinic.legalInfo,
        logoUrl,
        headerUrl,
        watermarkEnabled: clinic.watermarkEnabled,
      }
    : FALLBACK_TEMPLATE;

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
