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
        <label htmlFor="currentPassword" className="block text-sm font-medium text-foreground">
          Mot de passe actuel *
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      <div>
        <label htmlFor="newPassword" className="block text-sm font-medium text-foreground">
          Nouveau mot de passe *
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground">
          Confirmer le mot de passe *
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
        />
      </div>

      {state?.error && (
        <p className="text-sm text-destructive">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Mot de passe modifié avec succès.</p>
      )}

      <div className="pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-border-input px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending ? "Modification…" : "Changer le mot de passe"}
        </button>
      </div>
    </form>
  );
}
