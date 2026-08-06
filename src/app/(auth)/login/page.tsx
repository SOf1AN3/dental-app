"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);

    const result = await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });

    if (result?.error) {
      setError("Email ou mot de passe incorrect");
      setLoading(false);
    } else {
      router.push("/select-clinic");
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-cool-900">Connexion</h2>
        <p className="mt-1 text-sm text-cool-500">
          Connectez-vous à votre compte
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-cool-700">
            Mot de passe
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
            placeholder="••••••••"
          />
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {loading ? "Connexion..." : "Se connecter"}
        </button>
      </form>

      <div className="text-center">
        <a href="/forgot-password" className="text-sm font-medium text-cerulean hover:text-cerulean/80">
          Mot de passe oublié?
        </a>
      </div>

      <p className="text-center text-sm text-cool-500">
        Pas encore de compte?{" "}
        <a href="/register" className="font-medium text-cerulean hover:text-cerulean/80">
          S&apos;inscrire
        </a>
      </p>
    </div>
  );
}
