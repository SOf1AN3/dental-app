"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/lib/actions/auth";

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, undefined);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground">Mot de passe oublié</h2>
        <p className="mt-1 text-sm text-muted-fg">
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
            <label htmlFor="email" className="block text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-fg focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              placeholder="vous@exemple.fr"
            />
          </div>

          {state?.error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            {pending ? "Envoi..." : "Envoyer le lien"}
          </button>
        </form>
      )}

      <p className="text-center text-sm text-muted-fg">
        <a href="/login" className="font-medium text-cerulean hover:text-cerulean/80">
          Retour à la connexion
        </a>
      </p>
    </div>
  );
}
