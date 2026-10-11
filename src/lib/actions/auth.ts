"use server";

import { db } from "@/lib/db/db";
import { users } from "@/lib/db/schema";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  requireAuth,
  createAccountToken,
  consumeAccountToken,
} from "@/lib/auth-utils";
import {
  getResetLink,
  getVerifyLink,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email";
import { eq, sql } from "drizzle-orm";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

const registerSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  email: z.string().email("Email invalide"),
  password: z.string().min(6, "Mot de passe trop court"),
});

export async function register(prevState: { error?: string } | undefined, formData: FormData) {
  const validated = registerSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: "Veuillez vérifier les champs du formulaire" };
  }

  const data = validated.data;

  try {
    const existing = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.email, data.email),
    });

    if (existing) {
      return { error: "Un compte avec cet email existe déjà" };
    }

    const [created] = await db
      .insert(users)
      .values({
        name: data.name,
        email: data.email,
        passwordHash: await hashPassword(data.password),
      })
      .returning({ id: users.id });

    await logAction({
      clinicId: null,
      action: "create",
      entityType: "user",
      entityId: created.id,
      after: { name: data.name, email: data.email },
    });

    const token = await createAccountToken(created.id, "email_verification");
    await sendVerificationEmail(data.email, getVerifyLink(token));

    redirect("/verify-email");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: "Erreur lors de la création du compte" };
  }
}

const requestPasswordResetSchema = z.object({
  email: z.string().email("Email invalide"),
});

export async function requestPasswordReset(
  prevState: { success?: boolean; message?: string; error?: string } | undefined,
  formData: FormData
) {
  const validated = requestPasswordResetSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: "Veuillez vérifier les champs du formulaire" };
  }

  const { email } = validated.data;

  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, email),
  });

  if (user) {
    const token = await createAccountToken(user.id, "password_reset");
    await sendPasswordResetEmail(email, getResetLink(token));
  }

  return {
    success: true,
    message: "Si un compte existe avec cet email, un email de réinitialisation a été envoyé",
  };
}

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token requis"),
  password: z.string().min(6, "Mot de passe trop court"),
});

export async function resetPassword(
  prevState: { success?: boolean; error?: string } | undefined,
  formData: FormData
) {
  const validated = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: "Veuillez vérifier les champs du formulaire" };
  }

  const { token, password } = validated.data;

  const consumed = await consumeAccountToken(token, "password_reset");
  if (!consumed) {
    return { error: "Lien invalide ou expiré" };
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      // Invalide toutes les sessions JWT existantes (vérifié dans src/lib/auth.ts).
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, consumed.userId));

  return { success: true };
}

export async function verifyEmail(token: string) {
  const consumed = await consumeAccountToken(token, "email_verification");
  if (!consumed) {
    return { error: "Lien invalide ou expiré" };
  }

  await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.id, consumed.userId));

  return { success: true };
}

export async function resendVerificationEmail() {
  const user = await requireAuth();

  if (user.emailVerified) {
    return { success: false, error: "Votre email est déjà vérifié" };
  }

  const token = await createAccountToken(user.id, "email_verification");
  await sendVerificationEmail(user.email ?? "", getVerifyLink(token));

  return { success: true };
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Mot de passe actuel requis"),
  newPassword: z.string().min(6, "Le nouveau mot de passe doit faire au moins 6 caractères"),
  confirmPassword: z.string().min(1, "Confirmation requise"),
});

export async function changePassword(
  prevState: { success?: boolean; error?: string } | undefined,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const validated = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors.currentPassword?.[0]
      ?? validated.error.flatten().fieldErrors.newPassword?.[0]
      ?? validated.error.flatten().fieldErrors.confirmPassword?.[0]
      ?? "Veuillez vérifier les champs du formulaire" };
  }

  const { currentPassword, newPassword, confirmPassword } = validated.data;

  if (newPassword !== confirmPassword) {
    return { error: "Les mots de passe ne correspondent pas" };
  }

  const user = await requireAuth();

  const [dbUser] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!dbUser?.passwordHash) {
    return { error: "Impossible de vérifier le mot de passe actuel" };
  }

  const valid = await verifyPassword(currentPassword, dbUser.passwordHash);
  if (!valid) {
    return { error: "Le mot de passe actuel est incorrect" };
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      // Invalide toutes les sessions JWT existantes (vérifié dans src/lib/auth.ts).
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, user.id));

  await logAction({
    clinicId: null,
    action: "update",
    entityType: "user",
    entityId: user.id,
    after: { passwordChanged: true },
  });

  return { success: true };
}

export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
