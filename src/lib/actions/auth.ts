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
import { headers } from "next/headers";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

// ---------------------------------------------------------------------------
// Politique de mot de passe — accès à des données de santé : 12 caractères
// minimum partout où un mot de passe est (re)créé (inscription, réinitialisation,
// changement). Un `min(6)` se craque en quelques heures sur bcrypt.
// ---------------------------------------------------------------------------
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MIN_MESSAGE = "Mot de passe : 12 caractères minimum";

// ---------------------------------------------------------------------------
// Throttle des flux NON couverts par NextAuth (Z-15)
//
// `requestPasswordReset` et `register` n'avaient AUCUNE limite. Deux menaces :
//  (1) flood d'emails de réinitialisation / de vérification ;
//  (2) plus grave : relancer `requestPasswordReset` en boucle supprime à chaque
//      appel le token non consommé précédent (cf. `createAccountToken`) — un
//      attaquant pouvait donc INVALIDER SANS FIN le lien émis à une victime et
//      l'empêcher de réinitialiser son mot de passe.
//
// Fenêtre glissante en mémoire (Map) : aucune dépendance, aucune migration.
// Limites assumées et documentées : état volatile (remis à zéro au
// redémarrage) et par instance (plusieurs process = plafonds par instance).
// C'est une défense en profondeur en complément du plafond DB de la connexion
// (src/lib/auth.ts), pas un contrôle exact. La mémoire est bornée : entrées
// expirées purgées à vide, puis purge complète au-delà de MAX_KEYS (échec
// « ouvert » ponctuel, préférable à un OOM).
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_PER_EMAIL = 2;
const RESET_MAX_PER_IP = 10;
const REGISTER_MAX_PER_EMAIL = 3;
const REGISTER_MAX_PER_IP = 10;
const RATE_LIMIT_MAX_KEYS = 10_000;

const rateBuckets = new Map<string, number[]>();

/** Consomme une unité de budget ; `false` = plafond atteint (rien n'est fait). */
function consumeRateBudget(key: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (rateBuckets.get(key) ?? []).filter((t) => t > cutoff);

  if (rateBuckets.size >= RATE_LIMIT_MAX_KEYS && !rateBuckets.has(key)) {
    for (const [k, times] of rateBuckets) {
      if (times.every((t) => t <= cutoff)) rateBuckets.delete(k);
    }
    // Toujours saturée après purge : on vide tout (échec ouvert ponctuel).
    if (rateBuckets.size >= RATE_LIMIT_MAX_KEYS) rateBuckets.clear();
  }

  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}

/**
 * IP du client — même lecture que `src/lib/auth.ts` (`x-forwarded-for`,
 * spoofable). La limitation par IP n'est fiable que derrière un reverse proxy
 * de confiance qui écrase/ajoute cette en-tête ; usage : frein à
 * l'automatisation uniquement, jamais comme preuve d'identité.
 */
async function getRequestIp(): Promise<string> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    requestHeaders.get("x-real-ip") ||
    "unknown"
  );
}

const registerSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  email: z.string().email("Email invalide"),
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE),
});

export async function register(prevState: { error?: string } | undefined, formData: FormData) {
  const validated = registerSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    // Remonte le message de politique de mot de passe tel quel (comme
    // `changePassword`) plutôt qu'un générique qui masquerait le min(12).
    const fieldErrors = validated.error.flatten().fieldErrors;
    return {
      error:
        fieldErrors.password?.[0] ?? "Veuillez vérifier les champs du formulaire",
    };
  }

  const data = validated.data;
  const ip = await getRequestIp();

  // Plafond PAR ADRESSE puis PAR IP — appliqué AVANT toute recherche en base :
  // le refus ne doit jamais dépendre de l'existence du compte (sinon l'oracle
  // « trop de tentatives » vs « inscription acceptée » révélerait quelles
  // adresses sont déjà inscrites). Borne le flood d'emails de vérification.
  if (
    !consumeRateBudget(
      `register:email:${data.email.toLowerCase()}`,
      REGISTER_MAX_PER_EMAIL
    ) ||
    !consumeRateBudget(`register:ip:${ip}`, REGISTER_MAX_PER_IP)
  ) {
    return { error: "Trop de tentatives. Veuillez réessayer dans quelques minutes." };
  }

  try {
    const existing = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.email, data.email),
    });

    if (existing) {
      // Anti-énumération : « Un compte avec cet email existe déjà » permettait
      // de sonder quelles adresses ont un compte. On renvoie le même résultat
      // observable qu'une inscription réussie (redirection identique, aucun
      // email envoyé, aucun état modifié) — comme `requestPasswordReset`,
      // qui était déjà générique.
      redirect("/verify-email");
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
  const ip = await getRequestIp();

  // Plafond PAR ADRESSE — c'est lui qui neutralise l'invalidation en boucle du
  // lien (au plus RESET_MAX_PER_EMAIL créations de token / 15 min : relancer la
  // demande ne peut plus priver la victime de son lien) — puis PAR IP (frein au
  // flood de masse vers des milliers d'adresses). En cas de dépassement, on
  // renvoie le MÊME succès générique qu'en cas de succès : un message « trop de
  // demandes » distinct ne s'afficherait que pour des adresses existantes, ce
  // qui re-crée un oracle d'énumération.
  if (
    !consumeRateBudget(
      `reset:email:${email.toLowerCase()}`,
      RESET_MAX_PER_EMAIL
    ) ||
    !consumeRateBudget(`reset:ip:${ip}`, RESET_MAX_PER_IP)
  ) {
    return {
      success: true,
      message: "Si un compte existe avec cet email, un email de réinitialisation a été envoyé",
    };
  }

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
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE),
});

export async function resetPassword(
  prevState: { success?: boolean; error?: string } | undefined,
  formData: FormData
) {
  const validated = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    const fieldErrors = validated.error.flatten().fieldErrors;
    return {
      error:
        fieldErrors.password?.[0] ?? "Veuillez vérifier les champs du formulaire",
    };
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
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Le nouveau mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères`),
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
