"use client";

import { useActionState } from "react";
import { updateUserProfile } from "@/lib/actions/settings";

type DefaultValues = {
  name: string;
  email: string;
};

export function ProfileForm({
  defaultValues,
}: {
  defaultValues: DefaultValues;
}) {
  const [state, action, pending] = useActionState(updateUserProfile, undefined);

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
          Nom *
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

      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-cool-700"
        >
          Email *
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          defaultValue={defaultValues.email}
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
        {fieldErrors?.email && (
          <p className="mt-1 text-xs text-red-500">{fieldErrors.email[0]}</p>
        )}
      </div>

      {state?.success && (
        <p className="text-sm text-green-600 dark:text-green-400">Profil mis à jour.</p>
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
