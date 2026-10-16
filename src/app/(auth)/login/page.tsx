"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getDesktopApi, useIsDesktop } from "@/hooks/use-desktop";
import {
  BRIDGE_UNAVAILABLE_MESSAGE,
  attemptDesktopFallback,
} from "@/lib/offline/bootstrap-flow";

/**
 * Page de connexion — **un seul** bouton « Se connecter » (tâche P3).
 *
 * Le comportement local est inchangé : `signIn("credentials", …, redirect:
 * false)` puis `router.push("/select-clinic")`. Si le compte n'existe **pas
 * encore** en local (installation neuve de l'application de bureau, base
 * locale vide), le repli vers le serveur central est **invisible** :
 *
 *  1. erreur **et** mode desktop (`useIsDesktop()`) →
 *     `attemptDesktopFallback(email, password, deps)` enchaîne, sans jamais
 *     afficher de second formulaire :
 *     `api.loginToSync` (IPC) → `POST /api/sync/bootstrap` (même origine) →
 *     **un seul** second `signIn` ;
 *  2. succès du second `signIn` → `router.push("/select-clinic")` ;
 *  3. échec → message rédigé issu de la logique pure
 *     (`src/lib/offline/bootstrap-flow.ts`), affiché dans le bloc d'erreur ;
 *  4. mode web (`useIsDesktop()` → faux) → **aucun** IPC, **aucun** fetch
 *     bootstrap : « Email ou mot de passe incorrect », strictement comme avant.
 *
 * Le bouton reflète l'étape pendant tout le flux (`« Connexion… »` désactivé)
 * : l'utilisateur ne voit jamais clignoter un second formulaire.
 */
export default function LoginPage() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    // (1) Chemin local — inchangé.
    const result = await signIn("credentials", { email, password, redirect: false });

    // (2) Succès local — inchangé.
    if (!result.error) {
      router.push("/select-clinic");
      return;
    }

    // (4) Mode web — inchangé : aucun appel IPC ni bootstrap.
    if (!isDesktop) {
      setError("Email ou mot de passe incorrect");
      setLoading(false);
      return;
    }

    // (3) Mode desktop — repli invisible vers le serveur central.
    const api = getDesktopApi();
    if (api === null) {
      setError(BRIDGE_UNAVAILABLE_MESSAGE);
      setLoading(false);
      return;
    }

    const fallback = await attemptDesktopFallback(email, password, {
      loginToSync: (mail, pass) => api.loginToSync(mail, pass),
      signIn: (mail, pass) => signIn("credentials", { email: mail, password: pass, redirect: false }),
      // Wrap explicite : ne jamais extraire `fetch` nu (contrat `this` des
      // navigateurs), et garder la même origine que la page.
      fetchImpl: (url, init) => fetch(url, init),
    });

    if (fallback.kind === "signed-in") {
      router.push("/select-clinic");
      return;
    }
    setError(fallback.message);
    setLoading(false);
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground">Connexion</h2>
        <p className="mt-1 text-sm text-muted-fg">
          Connectez-vous à votre compte
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-foreground">
            Mot de passe
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-fg focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            placeholder="••••••••"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          aria-busy={loading}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {loading ? "Connexion…" : "Se connecter"}
        </button>
      </form>

      <div className="text-center">
        <a href="/forgot-password" className="text-sm font-medium text-cerulean hover:text-cerulean/80">
          Mot de passe oublié?
        </a>
      </div>

      <p className="text-center text-sm text-muted-fg">
        Pas encore de compte?{" "}
        <a href="/register" className="font-medium text-cerulean hover:text-cerulean/80">
          S&apos;inscrire
        </a>
      </p>
    </div>
  );
}
