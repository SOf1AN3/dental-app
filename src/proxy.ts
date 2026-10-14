/**
 * RÉ-EXPORT DU MIDDLEWARE UNIQUE — AUCUNE LOGIQUE ICI.
 *
 * Toute la logique (exemptions, verrou de vérification d'email,
 * `isValidActiveClinic`) vit dans `../proxy.ts`, fichier unique source de
 * vérité. Sa COPIE divergente — qui contenait les deux verrous plus stricts
 * mais ne s'appliquait JAMAIS — a été supprimée : deux copies EST le bug.
 *
 * Pourquoi ce fichier existe encore (et ne contient que ça) : Next 16.2.7 +
 * Turbopack construit sa liste des fichiers proxy surveillés à partir de
 * `<appDir>/..` = `src/` uniquement (`setup-dev-bundler.js` →
 * `getPossibleMiddlewareFilenames(path.join(rootDir, '..'))`, avec
 * `rootDir = pagesDir || appDir`). Mesuré sur dev server frais :
 *   • racine SEULE            → middleware DÉSACTIVÉ (aucune redirection) ;
 *   • racine + ce ré-export   → middleware ACTIF, la racine est exécutée ;
 *   • `src` seul              → middleware ACTIF, `src` est exécuté.
 * Ce ré-export existe donc pour ACTIVER le middleware en développement tout
 * en n'ayant qu'UN SEUL code, à la racine.
 */
import { proxy } from "../proxy";

export { proxy };

/**
 * Miroir LITTÉRAL du `config` de `../proxy.ts` (à maintenir identique) :
 * Next lit le `config` par analyse statique DANS ce fichier — sans littéral,
 * le matcher par défaut `(.*)` intercepterait les assets statiques et le
 * middleware redirigerait les JS/CSS anonymes vers /login.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
