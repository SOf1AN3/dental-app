"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createPatient } from "@/lib/actions/patient";
import { WILAYAS } from "@/lib/constants";

export function PatientForm() {
  const [state, action, pending] = useActionState(createPatient, undefined);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Informations personnelles
        </h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="firstName"
              className="block text-sm font-medium text-cool-700"
            >
              Prénom *
            </label>
            <input
              id="firstName"
              name="firstName"
              type="text"
              required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
            {fieldErrors?.firstName && (
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.firstName[0]}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="lastName"
              className="block text-sm font-medium text-cool-700"
            >
              Nom *
            </label>
            <input
              id="lastName"
              name="lastName"
              type="text"
              required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
            {fieldErrors?.lastName && (
              <p className="mt-1 text-xs text-red-500">
                {fieldErrors.lastName[0]}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="dateOfBirth"
              className="block text-sm font-medium text-cool-700"
            >
              Date de naissance
            </label>
            <input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label
              htmlFor="gender"
              className="block text-sm font-medium text-cool-700"
            >
              Genre
            </label>
            <select
              id="gender"
              name="gender"
              defaultValue=""
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            >
              <option value="">Non spécifié</option>
              <option value="Homme">Homme</option>
              <option value="Femme">Femme</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
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
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
              placeholder="+213 5XX XX XX XX"
            />
          </div>
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
            defaultValue=""
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
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Contact d&apos;urgence
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="emergencyContact"
              className="block text-sm font-medium text-cool-700"
            >
              Contact
            </label>
            <input
              id="emergencyContact"
              name="emergencyContact"
              type="text"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label
              htmlFor="emergencyPhone"
              className="block text-sm font-medium text-cool-700"
            >
              Téléphone
            </label>
            <input
              id="emergencyPhone"
              name="emergencyPhone"
              type="tel"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">Assurance</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="insuranceProvider"
              className="block text-sm font-medium text-cool-700"
            >
              Mutuelle
            </label>
            <input
              id="insuranceProvider"
              name="insuranceProvider"
              type="text"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
          <div>
            <label
              htmlFor="insuranceNumber"
              className="block text-sm font-medium text-cool-700"
            >
              N° d&apos;adhérent
            </label>
            <input
              id="insuranceNumber"
              name="insuranceNumber"
              type="text"
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">Notes</h2>
        <div>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Enregistrement..." : "Enregistrer"}
        </button>
        <Link
          href="/patients"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
