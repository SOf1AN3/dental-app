import { auth } from "@/lib/auth";
import { db } from "@/lib/db/db";
import { platformOwners, clinicMemberships, clinics, accountTokens } from "@/lib/db/schema";
import { eq, and, gt, isNull, isNotNull } from "drizzle-orm";
import { cache } from "react";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { can, isRole, type Ability, type Role } from "@/lib/permissions";

export const getCurrentUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user;
});

/**
 * Renvoie l'utilisateur de la session, ou redirige vers `/login`.
 *
 * Z-80 (NON appliqué, analyse documentée) : `emailVerified` n'est PAS exigé ici.
 * `src/proxy.ts` (lignes 62-70) l'impose déjà sur TOUTE requête HTTP — y
 * compris les POST de Server Actions, qui transittent par le proxy via le
 * matcher — à l'exception des pages de rattrapage `/verify-email` et
 * `/select-clinic`. Exiger `emailVerified` ici CASSERAIT ces rattrapages,
 * car `resendVerificationEmail` (`src/lib/actions/auth.ts`) repose sur
 * `requireAuth()` pour un compte NON vérifié : le `redirect("/verify-email")`
 * annulerait l'action de renvoi et bloquerait définitivement le compte.
 * Corriger cela demande une option explicite (ex. `requireAuth({ requireEmailVerified: false })`)
 * coordonnée avec `src/lib/actions/auth.ts` et les actions de `/select-clinic` —
 * hors périmètre de ce module.
 */
export const requireAuth = cache(async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
});

export async function getUserMemberships(userId: string) {
  return db
    .select({
      membership: clinicMemberships,
      clinic: clinics,
    })
    .from(clinicMemberships)
    .innerJoin(clinics, eq(clinicMemberships.clinicId, clinics.id))
    .where(and(
      eq(clinicMemberships.userId, userId),
      isNotNull(clinicMemberships.joinedAt),
      isNull(clinics.deletedAt)
    ));
}

export const requirePlatformOwner = cache(async () => {
  const user = await requireAuth();

  const owner = await db.query.platformOwners.findFirst({
    where: eq(platformOwners.userId, user.id),
  });

  if (!owner) {
    redirect("/login");
  }

  return { user, owner };
});

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function requireClinicAccessOrThrow(clinicId: string): Promise<void> {
  const user = await requireAuth();
  const membership = await db.query.clinicMemberships.findFirst({
    where: and(
      eq(clinicMemberships.userId, user.id),
      eq(clinicMemberships.clinicId, clinicId),
      isNotNull(clinicMemberships.joinedAt)
    ),
  });
  if (!membership) {
    throw new Error("Accès non autorisé à cette clinique");
  }
}

export async function getCurrentRole(clinicId: string): Promise<Role | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const membership = await db.query.clinicMemberships.findFirst({
    where: and(
      eq(clinicMemberships.userId, user.id),
      eq(clinicMemberships.clinicId, clinicId),
      isNotNull(clinicMemberships.joinedAt)
    ),
  });
  if (!membership || !isRole(membership.role)) return null;
  return membership.role;
}

/**
 * Non-throwing ability check for actions that surface errors as return values.
 */
export async function hasAbility(clinicId: string, ability: Ability): Promise<boolean> {
  const role = await getCurrentRole(clinicId);
  return role !== null && can(role, ability);
}

/**
 * Throwing variant for pages / void actions. Renders the error boundary with
 * an explicit message instead of silently proceeding.
 */
export async function requireAbility(clinicId: string, ability: Ability): Promise<void> {
  if (!(await hasAbility(clinicId, ability))) {
    throw new Error(`Accès refusé : capacité « ${ability} » requise`);
  }
}

export async function createAccountToken(
  userId: string,
  purpose: "password_reset" | "email_verification"
): Promise<string> {
  await db
    .delete(accountTokens)
    .where(
      and(
        eq(accountTokens.userId, userId),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt)
      )
    );

  const token = crypto.randomBytes(32).toString("hex");

  await db.insert(accountTokens).values({
    userId,
    token,
    purpose,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  return token;
}

export async function consumeAccountToken(
  token: string,
  purpose: "password_reset" | "email_verification"
): Promise<{ userId: string } | null> {
  // Z-76 — consommation ATOMIQUE en UNE requête. La version précédente
  // (SELECT puis UPDATE en deux requêtes) laissait une fenêtre TOCTOU : deux
  // appels concurrents du MÊME lien de reset lisaient tous deux
  // `used_at IS NULL` et consommaient tous deux le jeton — un jeton de
  // réinitialisation pouvait donc être RÉUTILISÉ.
  //
  // Ici l'`UPDATE … WHERE … AND used_at IS NULL RETURNING` est la seule
  // autorité : en READ COMMITTED, le second UPDATE attend le commit du
  // premier, réévalue son `WHERE` sur la version mise à jour de la ligne
  // (`used_at` n'est plus NULL, ou `expires_at` est dépassé) → 0 ligne
  // affectée → `null`. Les quatre prédicats sont identiques à l'ancienne
  // lecture : jeton, usage, non-consommé, non expiré ; le contrat de retour
  // `{ userId } | null` est inchangé.
  const consumedRows = await db
    .update(accountTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(accountTokens.token, token),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: accountTokens.userId });

  const [consumed] = consumedRows;
  if (!consumed) return null;

  return { userId: consumed.userId };
}
