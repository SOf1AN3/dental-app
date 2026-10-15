/**
 * Configuration de l'application desktop.
 *
 * Ce module est le point d'ancrage unique entre la landing (serveur) et le
 * binaire publié sur GitHub Releases : renseigner l'URL suffit à activer le
 * bouton de téléchargement, sans toucher au composant.
 *
 * ## URL de release STABLE
 *
 * L'URL pointe vers `releases/latest/download/<artefact>` et **ne doit pas**
 * contenir de version : `electron-builder.yml` impose
 * `artifactName: "DentalCare-Setup.${ext}"`, précisément pour que ce lien
 * reste valide à chaque nouvelle version. Si le nom d'artefact reprenait la
 * version (`DentalCare Setup 0.1.0.exe`), le lien casserait dès la 0.2.0.
 *
 * ## Priorité
 *
 *  1. `NEXT_PUBLIC_DESKTOP_APP_URL` (surcharge : prévisualisation Vercel, autre
 *     dépôt de release, miroir interne) ;
 *  2. la constante `RELEASE_DOWNLOAD_URL` ci-dessous (valeur par défaut).
 *
 * La variable `NEXT_PUBLIC_` est requise : elle est lue dans un composant
 * serveur de la landing et le préfixe la rend disponible au bundle client.
 */

/** URL de téléchargement par défaut (release la plus récente, artefact stable). */
export const RELEASE_DOWNLOAD_URL =
  "https://github.com/SOf1AN3/dental-app/releases/latest/download/DentalCare-Setup.exe";

/**
 * URL de téléchargement de l'application desktop, ou `null` si le binaire
 * n'est pas publié.
 *
 * `null` fait basculer la landing sur l'état « Bientôt disponible » (bouton
 * inactif) plutôt que de proposer un lien mort.
 */
export function getDesktopAppUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_DESKTOP_APP_URL;
  if (configured !== undefined && configured !== "") return configured;
  return RELEASE_DOWNLOAD_URL;
}
