"use client";

import { useActionState } from "react";
import { updateClinic } from "@/lib/actions/settings";
import { WILAYAS } from "@/lib/constants";

type DefaultValues = {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  wilayaCode: string | null;
  timezone: string | null;
};

export function ClinicSettingsForm({
  defaultValues,
}: {
  defaultValues: DefaultValues;
}) {
  const [state, action, pending] = useActionState(updateClinic, undefined);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={action} className="space-y-4">
      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-cool-700"
        >
          Nom de la clinique *
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues.name}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
        {fieldErrors?.name && (
          <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-cool-700"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={defaultValues.email ?? ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
          {fieldErrors?.email && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.email[0]}</p>
          )}
        </div>
        <div>
          <label
            htmlFor="phone"
            className="block text-sm font-medium text-cool-700"
          >
            Téléphone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={defaultValues.phone ?? ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="address"
          className="block text-sm font-medium text-cool-700"
        >
          Adresse
        </label>
        <input
          id="address"
          name="address"
          type="text"
          defaultValue={defaultValues.address ?? ""}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div>
        <label
          htmlFor="wilayaCode"
          className="block text-sm font-medium text-cool-700"
        >
          Wilaya
        </label>
        <select
          id="wilayaCode"
          name="wilayaCode"
          defaultValue={defaultValues.wilayaCode ?? ""}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        >
          <option value="">Sélectionner une wilaya</option>
          {WILAYAS.map((w) => (
            <option key={w.code} value={w.code}>
              {w.code} - {w.nameFr}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="timezone"
          className="block text-sm font-medium text-cool-700"
        >
          Fuseau horaire
        </label>
        <input
          id="timezone"
          name="timezone"
          type="text"
          defaultValue={defaultValues.timezone ?? "Africa/Algiers"}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      {state?.success && (
        <p className="text-sm text-green-600 dark:text-green-400">
          Informations de la clinique mises à jour.
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Enregistrement..." : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
