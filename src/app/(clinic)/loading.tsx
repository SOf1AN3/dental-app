/**
 * Squelette du segment `(clinic)` : reproduit la silhouette des pages
 * (en-tête `PageHeader` titre + description, grille de KPI `StatCards`,
 * bloc principal) pour éviter le « flash de mise en page » à l'arrivée du
 * contenu réel. `animate-pulse` + `bg-cool-100 dark:bg-cool-200` est la
 * convention déjà utilisée dans les Suspense des dashboards existants.
 *
 * Ce squelette ne reproduit NI la sidebar NI le header sticky : ils
 * appartiennent au layout `(clinic)/layout.tsx`, qui n'attend pas et reste
 * affiché pendant le chargement de la page (le layout rend le fallback
 * comme `{children}`).
 *
 * Largeur/padding — écart assumé avec le gabarit de la tâche : le fallback
 * est inséré **dans** le `<main className="mx-auto w-full max-w-[1400px]
 * flex-1 p-4 sm:p-6 lg:p-8">` du layout. Ce conteneur fournit donc déjà la
 * largeur (1400 px max, centrée) et l'insertion ; ré-appliquer
 * `p-4 sm:p-6 lg:p-8` ici doublerait l'insertion (32/48/64 px au lieu de
 * 16/24/32 px) et décalerait le squelette par rapport à la page réelle —
 * exactement le flash de mise en page qu'on cherche à supprimer.
 */
export default function ClinicLoading() {
  return (
    <div role="status" aria-live="polite">
      {/* Annonce SR : pas de texte visible dans un squelette, donc sr-only.
          Enfant unique du conteneur `space-y-*` interne pour ne pas fausser
          les marges entre blocs (le span sr-only est hors flux). */}
      <span className="sr-only">Chargement de la page…</span>

      <div className="animate-pulse space-y-6">
        {/* En-tête de page — silhouette d'un PageHeader (h1 + description) */}
        <div className="space-y-2">
          <div
            aria-hidden="true"
            className="h-7 w-56 rounded-lg bg-cool-100 dark:bg-cool-200"
          />
          <div
            aria-hidden="true"
            className="h-4 w-32 rounded-lg bg-cool-100 dark:bg-cool-200"
          />
        </div>

        {/* Grille de KPI — même grille que StatCards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-32 rounded-xl bg-cool-100 dark:bg-cool-200"
            />
          ))}
        </div>

        {/* Bloc principal (tableau, panneau, formulaire…) */}
        <div
          aria-hidden="true"
          className="h-72 rounded-xl bg-cool-100 dark:bg-cool-200"
        />
      </div>
    </div>
  );
}
