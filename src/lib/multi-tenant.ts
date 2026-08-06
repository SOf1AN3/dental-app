import "server-only";
import { db } from "@/lib/db/db";
import { clinicMemberships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function getCurrentClinicId(): Promise<string> {
  const cookieStore = await cookies();
  const clinicId = cookieStore.get("active_clinic_id")?.value;
  if (!clinicId) {
    redirect("/select-clinic");
  }
  return clinicId;
}

export async function requireClinicAccess(clinicId: string) {
  const user = await requireAuth();

  const membership = await db.query.clinicMemberships.findFirst({
    where: and(
      eq(clinicMemberships.userId, user.id),
      eq(clinicMemberships.clinicId, clinicId)
    ),
  });

  if (!membership) {
    throw new Error("No access to this clinic");
  }

  return { user, membership };
}
