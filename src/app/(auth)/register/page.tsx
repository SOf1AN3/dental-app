"use client";

import { useActionState } from "react";
import { register } from "@/lib/actions/auth";

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState(register, undefined);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-cool-900">Inscription</h2>
        <p className="mt-1 text-sm text-cool-500">
          Créez votre compte DentalCare
        </p>
      </div>

      {state?.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-cool-700">
            Nom complet
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>

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
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-cool-700">
            Mot de passe
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending ? "Inscription..." : "Créer un compte"}
        </button>
      </form>

      <p className="text-center text-sm text-cool-500">
        Déjà un compte?{" "}
        <a href="/login" className="font-medium text-cerulean hover:text-cerulean/80">
          Se connecter
        </a>
      </p>
    </div>
  );
}
