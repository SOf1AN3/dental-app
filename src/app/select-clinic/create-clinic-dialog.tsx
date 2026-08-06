"use client";

import { useState, useActionState } from "react";
import { createClinic } from "@/lib/actions/clinic";

export function CreateClinicDialog() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    async (_prevState: unknown, formData: FormData) => createClinic(formData),
    undefined
  );

  const stateError = state && 'error' in state ? state.error : undefined;
  const generalError = stateError && 'general' in stateError
    ? stateError.general?.[0]
    : undefined;
  const fieldErrors = stateError && !('general' in stateError)
    ? stateError as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border-2 border-dashed border-cool-300 bg-white px-6 py-3 text-sm font-medium text-cool-600 transition-colors hover:border-cerulean hover:text-cerulean"
      >
        <span className="text-lg">+</span>
        Créer une clinique
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-xl bg-white p-8 shadow-xl">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-cool-900">
                Nouvelle clinique
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="text-cool-400 hover:text-cool-600"
              >
                ✕
              </button>
            </div>

            <form action={action} className="space-y-4">
              {generalError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  {generalError}
                </div>
              )}

              <div>
                <label htmlFor="name" className="block text-sm font-medium text-cool-700">
                  Nom de la clinique *
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
                  placeholder="Cabinet Dentaire ..."
                />
                {fieldErrors?.name && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
                )}
              </div>

              <div>
                <label htmlFor="slug" className="block text-sm font-medium text-cool-700">
                  Slug (identifiant unique) *
                </label>
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  required
                  className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm font-mono focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
                  placeholder="cabinet-dentaire-..."
                />
                <p className="mt-1 text-xs text-cool-400">
                  Utilisé dans l&apos;URL : lettres minuscules, chiffres et tirets
                </p>
                {fieldErrors?.slug && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.slug[0]}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-cool-700">
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
                  />
                </div>
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-cool-700">
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
              </div>

              <div>
                <label htmlFor="address" className="block text-sm font-medium text-cool-700">
                  Adresse
                </label>
                <input
                  id="address"
                  name="address"
                  type="text"
                  className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
                >
                  {pending ? "Création..." : "Créer la clinique"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
