/**
 * Filet de sécurité racine : s'affiche pendant le chargement de toute route
 * qui n'a pas de `loading.tsx` de segment plus spécifique.
 *
 * Accessibilité — choix assumé :
 * - Le texte « Chargement… » reste **visible** (utile à l'utilisateur voyant,
 *   et la WCAG n'interdit pas un indicateur visuel de chargement) ;
 * - `role="status"` + `aria-live="polite"` sur le conteneur font annoncer ce
 *   même texte aux lecteurs d'écran, poliment et une seule fois ;
 * - Un `<span className="sr-only">Chargement</span>` serait donc **redondant**
 *   ici : il provoquerait une double annonce du même message. Il n'est ajouté
 *   que dans les squelettes sans texte visible (clinic/owner).
 * - Les blocs colorés sont purement décoratifs → `aria-hidden="true"`.
 */
export default function RootLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh items-center justify-center p-8"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-8 w-8 animate-pulse rounded-lg bg-cool-200 dark:bg-cool-300"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-fg">Chargement…</p>
      </div>
    </div>
  );
}
