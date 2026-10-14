import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

const publicRoutes = ["/login", "/register", "/auth/error"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // La landing (/) est la SEULE page publique en dehors du parcours
  // d'authentification. Sans cette exemption, le middleware la renverrait
  // vers /login et personne ne pourrait jamais la voir.
  const isLanding = pathname === "/";

  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  if (pathname.startsWith("/api/cron")) return NextResponse.next();
  if (publicRoutes.some((r) => pathname.startsWith(r))) return NextResponse.next();

  // Routes du poste desktop (application de bureau) : elles font leur PROPRE
  // authentification — `Authorization: Bearer` vérifié par verifyDeviceToken
  // (fail-closed) pour /push et /pull, et email+mot de passe bcrypt avec
  // limitation de débit pour /token. La session de navigateur n'existe pas
  // côté serveur central pour un appareil de bureau.
  const isSyncApiRoute =
    pathname === "/api/health" || pathname.startsWith("/api/sync/");
  if (isSyncApiRoute) return NextResponse.next();

  const session = await auth();
  if (!session?.user) {
    if (isLanding) return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Un compte déjà connecté ne doit pas se retrouver sur le discours
  // commercial : on le renvoie à son tableau de bord. La landing reste donc
  // exclusive aux visiteurs anonymes.
  if (isLanding) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const activeClinicId = request.cookies.get("active_clinic_id")?.value;
  const needsClinic =
    !pathname.startsWith("/select-clinic") &&
    !pathname.startsWith("/owner") &&
    !pathname.startsWith("/api");

  if (needsClinic && !activeClinicId) {
    return NextResponse.redirect(new URL("/select-clinic", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
