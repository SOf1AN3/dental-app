/**
 * MIDDLEWARE UNIQUE de l'application (Next 16 : convention `proxy.ts`,
 * anciennement `middleware.ts`) — CE FICHIER EST LA SOURCE UNIQUE DE LA
 * LOGIQUE.
 *
 * `src/proxy.ts` n'est plus qu'un RÉ-EXPORT (aucune logique) : sa copie
 * divergente a été supprimée — deux copies EST le bug. Elle contenait les
 * deux verrous plus stricts ci-dessous, qui ne s'appliquaient JAMAIS puisque
 * Next 16.2.7 exécute la racine quand les deux fichiers existent (mesuré :
 * `/api/cron/expire-quotes` → 503 = exemption de la racine). Ce ré-export
 * reste nécessaire car Turbopack ne repère les fichiers proxy qu'à partir de
 * `<appDir>/..` = `src/` : sans lui, le middleware est DÉSACTIVÉ en dev
 * (mesuré : `/dashboard` → 200 au lieu de 307). Voir l'en-tête de
 * `src/proxy.ts`.
 *
 * Verrous intégrés ICI, recopiés de l'ancienne copie morte, une seule fois :
 *
 *  1. le verrou de vérification d'email, strictement conditionné par
 *     `isEmailVerificationRequired()` (cf. `src/lib/email-verification.ts`) :
 *     exiger la vérification sans canal d'envoi enferme l'utilisateur sur
 *     `/verify-email` — c'est ce qui bloquait les 9 comptes en production ;
 *  2. `isValidActiveClinic()` : le cookie `active_clinic_id` n'est plus
 *     seulement recherché, il est REVALIDÉ à chaque requête (appartenance à
 *     une membership active, clinique non supprimée, non suspendue) ; cookie
 *     invalide → redirection `/select-clinic` + suppression du cookie.
 *
 * Exemptions conservées à l'identique (aucune régression mesurée) :
 * `/api/auth`, `/api/cron`, `publicRoutes`, la landing, et les routes de
 * synchronisation du poste desktop (`/api/health`, `/api/sync/*`).
 *
 * Runtime : proxy s'exécute sur le runtime Node.js (défaut Next 16), d'où
 * l'import possible de Drizzle/PostgreSQL ici.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { isEmailVerificationRequired } from "@/lib/email-verification";
import { db } from "@/lib/db/db";
import { clinicMemberships } from "@/lib/db/schema";

/**
 * Pages publiques hors toute vérification de session : parcours
 * d'authentification ouvert + page d'erreur. Exemption historique, conservée
 * à l'identique.
 */
const publicRoutes = ["/login", "/register", "/auth/error"];

/**
 * Autres pages du parcours d'authentification qui doivent rester atteignables
 * SANS session : `/forgot-password` et `/reset-password` sont la cible de
 * liens reçus par email (jeton dans l'URL), `/verify-email` celle du lien de
 * confirmation. Les rediriger vers /login enfermerait l'utilisateur dans une
 * boucle. (`/login` et `/register` sont déjà dans `publicRoutes`.)
 */
const authPages = ["/forgot-password", "/reset-password", "/verify-email"];

/**
 * Revalide que le cookie `active_clinic_id` correspond bien à une membership
 * ACTIVE de l'utilisateur de session : invitation jamais acceptée
 * (`joinedAt` null), clinique supprimée (`deletedAt`) ou suspendue
 * (`status = "suspended"`) ⇒ faux. Un cookie présent mais bidon (rejeu,
 * forçage) ne doit pas ouvrir l'espace clinique.
 */
async function isValidActiveClinic(
  request: NextRequest,
  sessionUserId: string
): Promise<boolean> {
  const clinicId = request.cookies.get("active_clinic_id")?.value;
  if (!clinicId) return true;

  const membership = await db.query.clinicMemberships.findFirst({
    where: and(
      eq(clinicMemberships.userId, sessionUserId),
      eq(clinicMemberships.clinicId, clinicId),
      isNotNull(clinicMemberships.joinedAt)
    ),
    with: { clinic: true },
  });

  if (!membership?.clinic) return false;

  return (
    membership.clinic.deletedAt === null &&
    membership.clinic.status !== "suspended"
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // La landing (/) est la SEULE page publique en dehors du parcours
  // d'authentification. Sans cette exemption, le middleware la renverrait
  // vers /login et personne ne pourrait jamais la voir.
  const isLanding = pathname === "/";

  // --- Exemptions : ni lecture de session, ni verrou appliqués. ---------
  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  if (pathname.startsWith("/api/cron")) return NextResponse.next();
  if (publicRoutes.some((r) => pathname.startsWith(r))) return NextResponse.next();

  // Routes du poste desktop (application de bureau) : elles font leur PROPRE
  // authentification — `Authorization: Bearer` vérifié par verifyDeviceToken
  // (fail-closed) pour /push et /pull, et email+mot de passe bcrypt avec
  // limitation de débit pour /token. La session de navigateur n'existe pas
  // côté serveur central pour un appareil de bureau. Sans cette exemption,
  // chaque appel anonyme serait redirigé (307) vers /login et aucun poste
  // de bureau ne pourrait synchroniser.
  const isSyncApiRoute =
    pathname === "/api/health" || pathname.startsWith("/api/sync/");
  if (isSyncApiRoute) return NextResponse.next();

  const session = await auth();
  const sessionUser = session?.user;
  const emailVerified = (
    sessionUser as { emailVerified?: string | null } | undefined
  )?.emailVerified;

  // --- Anonyme : landing + parcours d'authentification uniquement. -----
  if (!sessionUser) {
    if (isLanding) return NextResponse.next();
    if (authPages.some((r) => pathname.startsWith(r))) return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Un compte déjà connecté ne doit pas se retrouver sur le discours
  // commercial : on le renvoie à son tableau de bord. La landing reste donc
  // exclusive aux visiteurs anonymes.
  if (isLanding) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // --- Verrou 1 : vérification d'email (recopié de src/proxy.ts). ------
  // Le verrou n'est exigé QUE si un canal d'envoi existe (cf.
  // `isEmailVerificationRequired`). Sans clé Resend, rediriger vers
  // /verify-email enferme l'utilisateur : aucun email ne part, et le bouton
  // « Renvoyer » passe par le même canal muet. C'est exactement ce qui
  // bloquait les 9 comptes en production.
  if (
    isEmailVerificationRequired() &&
    !emailVerified &&
    pathname !== "/verify-email" &&
    !pathname.startsWith("/api/auth") &&
    pathname !== "/select-clinic"
  ) {
    return NextResponse.redirect(new URL("/verify-email", request.url));
  }

  // --- Verrou 2 : clinique active (présence PUIS validité du cookie). ---
  const sessionUserId = sessionUser.id;
  const needsClinic =
    !pathname.startsWith("/select-clinic") &&
    !pathname.startsWith("/owner") &&
    !pathname.startsWith("/api");

  if (needsClinic) {
    if (!request.cookies.get("active_clinic_id")?.value) {
      return NextResponse.redirect(new URL("/select-clinic", request.url));
    }

    if (sessionUserId && !(await isValidActiveClinic(request, sessionUserId))) {
      const response = NextResponse.redirect(
        new URL("/select-clinic", request.url)
      );
      response.cookies.delete({ name: "active_clinic_id", path: "/" });
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

