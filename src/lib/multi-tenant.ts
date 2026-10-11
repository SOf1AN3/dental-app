import "server-only";
import { db } from "@/lib/db/db";
import { clinicMemberships, clinics } from "@/lib/db/schema";
import { eq, and, isNotNull, isNull } from "drizzle-orm";
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

/**
 * Résout la clinique active depuis le cookie `active_clinic_id` ET vérifie
 * que l'utilisateur connecté en est bien membre, en une seule opération.
 *
 * - Cookie absent → redirection vers `/select-clinic` (via `getCurrentClinicId`).
 * - Utilisateur non membre de la clinique → `requireClinicAccess` lève une erreur.
 *
 * À utiliser de préférence à `getCurrentClinicId()` seule : ce helper ne fait
 * que LIRE le cookie, qui est forgeable côté client.
 */
export async function requireCurrentClinic(): Promise<string> {
  const clinicId = await getCurrentClinicId();
  await requireClinicAccess(clinicId);
  return clinicId;
}

export async function requireClinicAccess(clinicId: string) {
  const user = await requireAuth();

  // Cohérence avec `getUserMemberships` (src/lib/auth-utils.ts) et le
  // middleware (src/proxy.ts) : une clinique ARCHIVÉE par le platform owner
  // (clinics.deletedAt non nul) n'est plus accessible à ses membres. Tester
  // uniquement `clinicMemberships` laissait ses membres dedans après
  // archivage. INNER JOIN sur `clinic` : une membership ne peut pas pointer
  // une clinic orpheline (FK), donc le JOIN ne filtre rien d'autre, et la
  // clé primaire de `clinic` garde le coût du plan quasi identique.
  const rows = await db
    .select({ membership: clinicMemberships })
    .from(clinicMemberships)
    .innerJoin(clinics, eq(clinicMemberships.clinicId, clinics.id))
    .where(
      and(
        eq(clinicMemberships.userId, user.id),
        eq(clinicMemberships.clinicId, clinicId),
        isNotNull(clinicMemberships.joinedAt),
        isNull(clinics.deletedAt)
      )
    )
    .limit(1);

  const membership = rows[0]?.membership;

  if (!membership) {
    throw new Error("No access to this clinic");
  }

  return { user, membership };
}
