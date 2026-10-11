/**
 * Verrou de vérification d'email.
 *
 * Principe : on ne peut exiger une confirmation d'email que si l'on est
 * capable d'ENVOYER l'email de confirmation. Exiger la vérification sans
 * fournir de clé Resend enferme l'utilisateur sur `/verify-email` sans
 * aucune issue — c'est exactement ce qui s'est produit en production,
 * où les 9 comptes étaient tous bloqués faute d'`EMAIL_RESEND_API_KEY`.
 *
 * Une seule source de vérité, consommée par :
 *   - `src/proxy.ts`           : le middleware ne redirige plus vers /verify-email
 *   - `src/lib/actions/auth.ts` : l'inscription n'envoie ni jeton, et ne
 *                                 redirige pas vers /verify-email
 *
 * La colonne `users.emailVerified` reste **honnête** (elle n'est pas forcée) :
 * un compte non vérifié est bel et bien non vérifié. On ne fait que cesser
 * d'exiger la vérification tant qu'aucun canal d'envoi n'existe. Brancher
 * `EMAIL_RESEND_API_KEY` rétablit donc le verrou pour les comptes à venir,
 * sans toucher aux données.
 */

/**
 * Vrai si l'application doit exiger la vérification de l'email.
 *
 * Dépend exclusivement de la présence d'une clé Resend : c'est la seule
 * condition qui rende l'envoi réellement possible.
 */
export function isEmailVerificationRequired(): boolean {
  return Boolean(process.env.EMAIL_RESEND_API_KEY);
}

/**
 * URL de l'application, utilisée pour construire les liens envoyés par email.
 *
 * `NEXT_PUBLIC_APP_URL` doit être définie en production : sans elle, les
 * liens pointeraient vers `http://localhost:3000` et seraient inutilisables
 * pour le destinataire.
 */
export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}
