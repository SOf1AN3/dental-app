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
          className="block text-sm font-medium text-foreground"
        >
          Nom *
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues.name}
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
        {fieldErrors?.name && (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.name[0]}</p>
        )}
      </div>

      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-foreground"
        >
          Email *
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          defaultValue={defaultValues.email}
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
        {fieldErrors?.email && (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.email[0]}</p>
        )}
      </div>

      {state?.success && (
        <p className="text-sm text-green-600 dark:text-green-400">Profil mis à jour.</p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending ? "Enregistrement..." : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
