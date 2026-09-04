"use client";

import { useActionState } from "react";
import { changePassword } from "@/lib/actions/auth";

/**
 * PAR-2: Password change form embedded in the profile page.
 * Current password + new password + confirmation, min 6 chars.
 */
export function PasswordChangeForm() {
  const [state, action, pending] = useActionState(changePassword, undefined);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="currentPassword" className="block text-sm font-medium text-cool-700">
          Mot de passe actuel *
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div>
        <label htmlFor="newPassword" className="block text-sm font-medium text-cool-700">
          Nouveau mot de passe *
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-cool-700">
          Confirmer le mot de passe *
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
        />
      </div>

      {state?.error && (
        <p className="text-sm text-red-600">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Mot de passe modifié avec succès.</p>
      )}

      <div className="pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-700 hover:bg-cool-50 disabled:opacity-50 transition-colors"
        >
          {pending ? "Modification…" : "Changer le mot de passe"}
        </button>
      </div>
    </form>
  );
}
