import { auth } from "@/lib/auth";
import { db } from "@/lib/db/db";
import { platformOwners, clinicMemberships, clinics, accountTokens } from "@/lib/db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { cache } from "react";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export const getCurrentUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user;
});

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
    .where(and(eq(clinicMemberships.userId, userId), isNull(clinics.deletedAt)));
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
      eq(clinicMemberships.clinicId, clinicId)
    ),
  });
  if (!membership) {
    throw new Error("Accès non autorisé à cette clinique");
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
  const found = await db.query.accountTokens.findFirst({
    where: and(
      eq(accountTokens.token, token),
      eq(accountTokens.purpose, purpose),
      isNull(accountTokens.usedAt),
      gt(accountTokens.expiresAt, new Date())
    ),
  });

  if (!found) return null;

  await db
    .update(accountTokens)
    .set({ usedAt: new Date() })
    .where(eq(accountTokens.id, found.id));

  return { userId: found.userId };
}
