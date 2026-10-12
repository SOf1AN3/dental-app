/**
 * Configuration de l'application desktop.
 *
 * La version bureau n'est pas encore livrée : ce module est le point
 * d'ancrage unique qui permettra de la brancher sans toucher au composant.
 *
 * Renseigner `NEXT_PUBLIC_DESKTOP_APP_URL` (Vercel / `.env`) suffit à
 * activer le bouton de téléchargement sur la landing. Tant que la variable
 * est absente, `getDesktopAppUrl()` renvoie `null` et le composant affiche
 * l'état « Bientôt disponible » — au lieu d'un lien mort.
 *
 * Aucun code de build desktop (Electron, Tauri…) n'existe encore dans ce
 * dépôt : seule la présentation est prête, l'intégration se résumera à
 * publier le binaire et à poser la variable.
 */

/**
 * URL de téléchargement de l'application desktop, ou `null` si le binaire
 * n'est pas encore publié.
 *
 * NB : variable `NEXT_PUBLIC_` car elle est lue dans un composant serveur
 * de la landing ; le préfixe garantit qu'elle est exposée au bundle
 * client sans configuration supplémentaire.
 */
export function getDesktopAppUrl(): string | null {
  return process.env.NEXT_PUBLIC_DESKTOP_APP_URL || null;
}
