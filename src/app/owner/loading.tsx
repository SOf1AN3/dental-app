/**
 * Squelette de la console propriétaire (`/owner/*`) : même principe que
 * `(clinic)/loading.tsx`, silhouette simplifiée (en-tête + 4 cartes KPI +
 * bloc principal), convention `animate-pulse` + `bg-cool-100
 * dark:bg-cool-200` des dashboards existants.
 *
 * La sidebar et le header sticky sont rendus par `owner/layout.tsx` (non
 * asynchrone côté loading) et ne sont donc pas reproduits ici.
 *
 * Largeur/padding — écart assumé avec le gabarit de la tâche : le fallback
 * s'exécute comme `{children}` **dans** le `<main className="mx-auto w-full
 * max-w-[1400px] flex-1 p-4 sm:p-6 lg:p-8">` d'`owner/layout.tsx`, qui
 * fournit déjà ces contraintes. Ré-appliquer classes équivalentes ici
 * doublerait l'insertion et décalerait le squelette par rapport aux pages
 * réelles.
 */
export default function OwnerLoading() {
  return (
    <div role="status" aria-live="polite">
      {/* Squelette sans texte visible : annonce SR dédiée, hors flux pour
          ne pas perturber les marges du conteneur `space-y-6`. */}
      <span className="sr-only">Chargement de la page…</span>

      <div className="animate-pulse space-y-6">
        {/* En-tête de page */}
        <div className="space-y-2">
          <div
            aria-hidden="true"
            className="h-7 w-64 rounded-lg bg-cool-100 dark:bg-cool-200"
          />
          <div
            aria-hidden="true"
            className="h-4 w-40 rounded-lg bg-cool-100 dark:bg-cool-200"
          />
        </div>

        {/* Cartes KPI */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-28 rounded-xl bg-cool-100 dark:bg-cool-200"
            />
          ))}
        </div>

        {/* Bloc principal */}
        <div
          aria-hidden="true"
          className="h-64 rounded-xl bg-cool-100 dark:bg-cool-200"
        />
      </div>
    </div>
  );
}
