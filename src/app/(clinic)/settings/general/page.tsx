import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { ClinicSettingsForm } from "@/components/clinic/clinic-settings-form";
import { ProfileForm } from "@/components/clinic/profile-form";
import { PasswordChangeForm } from "@/components/clinic/password-change-form";

export default async function GeneralSettingsPage() {
  await requireAuth();

  const [clinic, profile] = await Promise.all([
    getCurrentClinic(),
    getCurrentUserProfile(),
  ]);

  if (!clinic) {
    return (
      <p className="text-sm text-red-500">
        Clinique introuvable.
      </p>
    );
  }

  if (!profile) {
    return (
      <p className="text-sm text-red-500">
        Profil introuvable.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Informations de la clinique
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Ces informations apparaissent sur les documents et communications.
        </p>
        <ClinicSettingsForm
          defaultValues={{
            name: clinic.name,
            email: clinic.email,
            phone: clinic.phone,
            address: clinic.address,
            wilayaCode: clinic.wilayaCode,
            timezone: clinic.timezone,
            defaultTaxRate: clinic.defaultTaxRate,
          }}
        />
      </section>

      <section className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Votre profil
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Mettez à jour votre nom et votre adresse email.
        </p>
        <ProfileForm
          defaultValues={{
            name: profile.name ?? "",
            email: profile.email ?? "",
          }}
        />
      </section>

      <section className="rounded-xl border border-cool-200 bg-white p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Changer le mot de passe
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Vérifiez votre mot de passe actuel, puis entrez le nouveau.
        </p>
        <PasswordChangeForm />
      </section>
    </div>
  );
}
