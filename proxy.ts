import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

const publicRoutes = ["/login", "/register", "/auth/error"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  if (pathname.startsWith("/api/cron")) return NextResponse.next();
  if (publicRoutes.some((r) => pathname.startsWith(r))) return NextResponse.next();

  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", request.url));
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
