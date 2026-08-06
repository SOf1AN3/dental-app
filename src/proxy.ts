import { auth } from "@/lib/auth";
import { db } from "@/lib/db/db";
import { clinicMemberships } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

async function isValidActiveClinic(
  request: NextRequest,
  sessionUserId: string
): Promise<boolean> {
  const clinicId = request.cookies.get("active_clinic_id")?.value;
  if (!clinicId) return true;

  const membership = await db.query.clinicMemberships.findFirst({
    where: and(
      eq(clinicMemberships.userId, sessionUserId),
      eq(clinicMemberships.clinicId, clinicId)
    ),
    with: { clinic: true },
  });

  if (!membership?.clinic) return false;

  return (
    membership.clinic.deletedAt === null &&
    membership.clinic.status !== "suspended"
  );
}

export async function proxy(request: NextRequest) {
  const session = await auth();
  const isLoggedIn = !!session?.user;
  const emailVerified = (session?.user as { emailVerified?: string | null } | undefined)?.emailVerified;

  const { pathname } = request.nextUrl;

  const isAuthPage =
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/verify-email");
  const isApiAuthRoute = pathname.startsWith("/api/auth");
  const isOwnerRoute = pathname.startsWith("/owner");
  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname.startsWith("/uploads") ||
    pathname === "/favicon.ico";

  if (isPublicAsset || isApiAuthRoute) {
    return NextResponse.next();
  }

  if (!isLoggedIn && !isAuthPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (isLoggedIn && isAuthPage && !pathname.startsWith("/verify-email")) {
    return NextResponse.redirect(new URL("/select-clinic", request.url));
  }

  if (
    isLoggedIn &&
    !emailVerified &&
    pathname !== "/verify-email" &&
    !pathname.startsWith("/api/auth") &&
    pathname !== "/select-clinic"
  ) {
    return NextResponse.redirect(new URL("/verify-email", request.url));
  }

  const sessionUserId = session?.user?.id;
  const isClinicArea =
    isLoggedIn &&
    !!sessionUserId &&
    !isAuthPage &&
    !isOwnerRoute &&
    pathname !== "/select-clinic";

  if (isClinicArea && sessionUserId) {
    if (!(await isValidActiveClinic(request, sessionUserId))) {
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads).*)"],
};
