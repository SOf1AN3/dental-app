"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/lib/actions/auth";

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, undefined);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-cool-900">Mot de passe oublié</h2>
        <p className="mt-1 text-sm text-cool-500">
          Entrez votre email pour recevoir un lien de réinitialisation
        </p>
      </div>

      {state?.success ? (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400">
          {state.message}
        </div>
      ) : (
        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-cool-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
              placeholder="vous@exemple.fr"
            />
          </div>

          {state?.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
          >
            {pending ? "Envoi..." : "Envoyer le lien"}
          </button>
        </form>
      )}

      <p className="text-center text-sm text-cool-500">
        <a href="/login" className="font-medium text-cerulean hover:text-cerulean/80">
          Retour à la connexion
        </a>
      </p>
    </div>
  );
}
