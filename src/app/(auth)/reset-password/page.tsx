"use client";

import { Suspense, useState } from "react";
import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { resetPassword } from "@/lib/actions/auth";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [matchError, setMatchError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(resetPassword, undefined);

  if (!token) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-cool-900">Réinitialiser le mot de passe</h2>
        </div>
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
          Lien invalide ou expiré
        </div>
        <p className="text-center text-sm text-cool-500">
          <a href="/forgot-password" className="font-medium text-cerulean hover:text-cerulean/80">
            Demander un nouveau lien
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-cool-900">Réinitialiser le mot de passe</h2>
        <p className="mt-1 text-sm text-cool-500">
          Choisissez un nouveau mot de passe
        </p>
      </div>

      {state?.success ? (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400">
          Votre mot de passe a été réinitialisé avec succès
        </div>
      ) : (
        <form
          action={formAction}
          onSubmit={(e) => {
            const form = e.currentTarget;
            const password = new FormData(form).get("password") as string;
            const confirmPassword = new FormData(form).get("confirmPassword") as string;
            if (password !== confirmPassword) {
              e.preventDefault();
              setMatchError("Les mots de passe ne correspondent pas");
            } else {
              setMatchError(null);
            }
          }}
          className="space-y-4"
        >
          <input type="hidden" name="token" value={token} />

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-cool-700">
              Nouveau mot de passe
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-cool-700">
              Confirmer le mot de passe
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
              placeholder="••••••••"
            />
          </div>

          {matchError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
              {matchError}
            </div>
          )}

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
            {pending ? "Enregistrement..." : "Réinitialiser le mot de passe"}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="text-sm text-cool-500">Chargement...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
