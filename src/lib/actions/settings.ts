"use server";

import { db } from "@/lib/db/db";
import { clinics, users, clinicMemberships, clinicSchedule } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow, hasAbility, createAccountToken } from "@/lib/auth-utils";
import { isPractitionerRole } from "@/lib/constants";
import { getVerifyLink, sendEmail, sendVerificationEmail } from "@/lib/email";
import { storage } from "@/lib/storage";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { documentBrandingSchema } from "@/lib/document-branding";

export async function getCurrentClinic() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db.query.clinics.findFirst({
      where: eq(clinics.id, clinicId),
    });
  } catch {
    return null;
  }
}

export async function getCurrentUserProfile() {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // `columns` explicite : ne jamais renvoyer `passwordHash` au client.
    return await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
      },
    });
  } catch {
    return null;
  }
}

const clinicSchema = z.object({
  name: z.string().min(1, "Nom de la clinique requis"),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  wilayaCode: z.string().optional().or(z.literal("")),
  timezone: z.string().optional().or(z.literal("")),
  defaultTaxRate: z.coerce.number().min(0).max(100).optional().default(19),
});

export async function updateClinic(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return {
      success: false,
      error: { general: ["Seul le propriétaire peut modifier les paramètres de la clinique"] },
    };
  }

  const validated = clinicSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        name: clinics.name,
        email: clinics.email,
        phone: clinics.phone,
        address: clinics.address,
        wilayaCode: clinics.wilayaCode,
        timezone: clinics.timezone,
        legalInfo: clinics.legalInfo,
        logoUrl: clinics.logoUrl,
        headerUrl: clinics.headerUrl,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    const updateData: Partial<typeof clinics.$inferInsert> = {
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      address: data.address || null,
      wilayaCode: data.wilayaCode || null,
      timezone: data.timezone || "Africa/Algiers",
      defaultTaxRate: data.defaultTaxRate ?? 19,
    };

    // Handle logo upload
    const logoFile = formData.get("logo") as File | null;
    if (logoFile && logoFile.size > 0) {
      const logoKey = await storage.upload(logoFile, `clinics/${clinicId}/logo`);
      updateData.logoUrl = logoKey;
    }

    // Handle header upload
    const headerFile = formData.get("header") as File | null;
    if (headerFile && headerFile.size > 0) {
      const headerKey = await storage.upload(headerFile, `clinics/${clinicId}/header`);
      updateData.headerUrl = headerKey;
    }

    await db
      .update(clinics)
      .set(updateData)
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_settings",
      entityId: clinicId,
      before: current ? {
        name: current.name,
        email: current.email ?? null,
        phone: current.phone ?? null,
        address: current.address ?? null,
        wilayaCode: current.wilayaCode ?? null,
        timezone: current.timezone ?? null,
        logoUrl: current.logoUrl ?? null,
        headerUrl: current.headerUrl ?? null,
      } : undefined,
      after: updateData as Record<string, unknown>,
    });

    revalidatePath("/settings/general");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour de la clinique"] } };
  }
}

const logoBrandingSchema = z.object({
  legalInfo: z.string().optional().or(z.literal("")),
});

export async function updateDocumentBranding(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return {
      success: false,
      error: { general: ["Seul le propriétaire peut modifier l'identité des documents"] },
    };
  }

  const validated = logoBrandingSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        logoUrl: clinics.logoUrl,
        headerUrl: clinics.headerUrl,
        legalInfo: clinics.legalInfo,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    const updateData: Partial<typeof clinics.$inferInsert> = {
      legalInfo: data.legalInfo || null,
    };

    const logoFile = formData.get("logo") as File | null;
    if (logoFile && logoFile.size > 0) {
      const logoKey = await storage.upload(logoFile, `clinics/${clinicId}/logo`);
      updateData.logoUrl = logoKey;
    }

    const headerFile = formData.get("header") as File | null;
    if (headerFile && headerFile.size > 0) {
      const headerKey = await storage.upload(headerFile, `clinics/${clinicId}/header`);
      updateData.headerUrl = headerKey;
    }

    await db
      .update(clinics)
      .set(updateData)
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_settings",
      entityId: clinicId,
      before: current ? {
        logoUrl: current.logoUrl ?? null,
        headerUrl: current.headerUrl ?? null,
        legalInfo: current.legalInfo ?? null,
      } : undefined,
      after: updateData as Record<string, unknown>,
    });

    revalidatePath("/settings/documents");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour de l'apparence des documents"] } };
  }
}

const clinicTemplateSchema = z.object({
  watermarkEnabled: z.boolean().default(false),
});

export async function updateClinicTemplate(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return {
      success: false,
      error: { general: ["Seul le propriétaire peut modifier les modèles de documents"] },
    };
  }

  const raw: Record<string, unknown> = Object.fromEntries(formData);
  raw.watermarkEnabled = formData.has("watermarkEnabled");

  const validated = clinicTemplateSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        watermarkEnabled: clinics.watermarkEnabled,
        logoUrl: clinics.logoUrl,
        headerUrl: clinics.headerUrl,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    const updateData: Partial<typeof clinics.$inferInsert> = {
      watermarkEnabled: data.watermarkEnabled,
    };

    // Handle logo upload
    const logoFile = formData.get("logo") as File | null;
    if (logoFile && logoFile.size > 0) {
      const logoKey = await storage.upload(logoFile, `clinics/${clinicId}/logo`);
      updateData.logoUrl = logoKey;
    }

    // Handle header upload
    const headerFile = formData.get("header") as File | null;
    if (headerFile && headerFile.size > 0) {
      const headerKey = await storage.upload(headerFile, `clinics/${clinicId}/header`);
      updateData.headerUrl = headerKey;
    }

    await db
      .update(clinics)
      .set(updateData)
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_settings",
      entityId: clinicId,
      before: current ? {
        watermarkEnabled: current.watermarkEnabled,
        logoUrl: current.logoUrl ?? null,
        headerUrl: current.headerUrl ?? null,
      } : undefined,
      after: updateData as Record<string, unknown>,
    });

    revalidatePath("/settings/documents");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour du modèle d'ordonnance"] } };
  }
}

export async function updateDocumentTemplates(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return {
      success: false,
      error: { general: ["Seul le propriétaire peut modifier l'identité des documents"] },
    };
  }

  const validated = documentBrandingSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const d = validated.data;
  const branding = {
    template: d.template,
    primary: d.primary,
    secondary: d.secondary,
    tagline: d.tagline ? d.tagline.trim() : null,
    footer: d.footer ? d.footer.trim() : null,
  };
  const watermarkEnabled = formData.has("watermarkEnabled");

  try {
    const [current] = await db
      .select({
        documentBranding: clinics.documentBranding,
        watermarkEnabled: clinics.watermarkEnabled,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    await db
      .update(clinics)
      .set({ documentBranding: branding, watermarkEnabled })
      .where(eq(clinics.id, clinicId));

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_settings",
      entityId: clinicId,
      before: {
        documentBranding: current?.documentBranding ?? null,
        watermarkEnabled: current?.watermarkEnabled ?? false,
      },
      after: { documentBranding: branding, watermarkEnabled },
    });

    revalidatePath("/settings/documents");
    revalidatePath("/prescriptions");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour de l'identité des documents"] } };
  }
}

const profileSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  email: z.string().email("Email invalide"),
});

export async function updateUserProfile(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = profileSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    // Z-78 — lit l'adresse ACTUELLE en base (jamais la session JWT, qui peut
    // être périmée) pour décider si l'adresse de connexion change réellement.
    const current = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { id: true, email: true },
    });
    const previousEmail = current?.email ?? null;
    const emailChanged = previousEmail !== null && previousEmail !== data.email;

    // Check email uniqueness
    const existing = await db.query.users.findFirst({
      where: (users, { eq, ne }) => and(eq(users.email, data.email), ne(users.id, user.id)),
      columns: { id: true },
    });

    if (existing) {
      return { success: false, error: { email: ["Cet email est déjà utilisé"] } };
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      name: data.name,
      email: data.email,
    };

    if (emailChanged) {
      // Z-78 — l'adresse de connexion change SANS ré-vérification : la preuve
      // de possession de l'ancienne adresse est périmée. On repasse
      // `emailVerified` à NULL : le callback `jwt` de `src/lib/auth.ts`
      // relit la colonne à chaque requête, donc `proxy.ts` bloque l'accès
      // jusqu'à nouvelle vérification par le flux EXISTANT (`/verify-email` +
      // `resendVerificationEmail`), dont le jeton prouve le contrôle de la
      // NOUVELLE adresse.
      updateData.emailVerified = null;
    }

    await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, user.id));

    await logAction({
      clinicId,
      action: "update",
      entityType: "user",
      entityId: user.id,
      before: { name: user.name ?? null, email: user.email ?? null },
      after: { name: data.name, email: data.email },
    });

    if (emailChanged && previousEmail) {
      await notifyEmailChange(previousEmail, data.email, user.id);
    }

    revalidatePath("/settings/general");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour du profil"] } };
  }
}

/**
 * Z-78 — notifications post-changement d'email (BEST-EFFORT) : jamais
 * bloquantes, envoyées APRÈS la validation et l'écriture en base.
 *
 * 1. à la NOUVELLE adresse : lien de vérification (le jeton prouve le
 *    contrôle — même mécanisme et même jeton que l'inscription) ;
 * 2. à l'ANCIENNE adresse : simple information, SANS lien ni jeton — si le
 *    changement n'était pas légitime, son titulaire peut réinitialiser son
 *    mot de passe depuis l'application.
 *
 * `sendEmail` n'échoue jamais (il attrape ses propres erreurs) mais
 * `createAccountToken` touche la base : chaque envoi a son propre
 * `try/catch` pour qu'un échec n'empêche pas l'autre ni ne remonte une
 * exception dans l'action.
 */
async function notifyEmailChange(
  previousEmail: string,
  newEmail: string,
  userId: string,
): Promise<void> {
  try {
    const token = await createAccountToken(userId, "email_verification");
    await sendVerificationEmail(newEmail, getVerifyLink(token));
  } catch (error) {
    console.error("Échec de l'envoi de l'email de vérification après changement d'adresse", error);
  }

  try {
    await sendEmail({
      to: previousEmail,
      subject: "Votre adresse email DentalCare a été modifiée",
      html: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h1 style="font-size: 22px; font-weight: 700; color: #1e2a5a; margin: 0 0 16px;">DentalCare</h1>
          <p style="color: #3f424e; line-height: 1.6;">Bonjour,</p>
          <p style="color: #3f424e; line-height: 1.6;">
            L'adresse email de connexion associée à votre compte vient d'être
            modifiée. Un email de vérification a été envoyé à la nouvelle
            adresse : votre compte n'est plus accessible tant qu'elle n'est
            pas vérifiée.
          </p>
          <p style="color: #3f424e; line-height: 1.6;">
            Si vous n'êtes pas à l'origine de ce changement, réinitialisez
            immédiatement votre mot de passe depuis l'application.
          </p>
          <p style="color: #858b9e; font-size: 14px; line-height: 1.5;">
            Cet email est informatif et ne contient aucun lien.
          </p>
        </div>
      `,
    });
  } catch (error) {
    console.error("Échec de la notification sur l'ancienne adresse email", error);
  }
}

export async function updateClinicSchedule(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  void prevState;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return { success: false, error: { general: ["Seul le propriétaire peut modifier les horaires"] } };
  }

  const days: {
    dayOfWeek: number;
    openTime: string | null;
    closeTime: string | null;
    isClosed: boolean;
    isWeekend: boolean;
  }[] = [];

  for (let i = 0; i < 7; i++) {
    const isClosed = formData.has(`closed-${i}`);
    const isWeekend = formData.has(`weekend-${i}`);
    const openRaw = String(formData.get(`open-${i}`) ?? "").trim();
    const closeRaw = String(formData.get(`close-${i}`) ?? "").trim();

    let openTime: string | null = null;
    let closeTime: string | null = null;

    if (!isClosed) {
      if (openRaw === "" || closeRaw === "") {
        return { success: false, error: { general: ["Horaires manquants pour un jour ouvert"] } };
      }
      if (!/^\d{2}:\d{2}$/.test(openRaw) || !/^\d{2}:\d{2}$/.test(closeRaw)) {
        return { success: false, error: { general: ["Horaires invalides"] } };
      }
      const [openH, openM] = openRaw.split(":").map(Number);
      const [closeH, closeM] = closeRaw.split(":").map(Number);
      if (openH * 60 + openM >= closeH * 60 + closeM) {
        return { success: false, error: { general: ["L'heure de fermeture doit être après l'heure d'ouverture"] } };
      }
      openTime = `${openRaw}:00`;
      closeTime = `${closeRaw}:00`;
    } else if (openRaw !== "" || closeRaw !== "") {
      if (
        (openRaw !== "" && !/^\d{2}:\d{2}$/.test(openRaw)) ||
        (closeRaw !== "" && !/^\d{2}:\d{2}$/.test(closeRaw))
      ) {
        return { success: false, error: { general: ["Horaires invalides"] } };
      }
      openTime = openRaw !== "" ? `${openRaw}:00` : null;
      closeTime = closeRaw !== "" ? `${closeRaw}:00` : null;
    }

    days.push({ dayOfWeek: i, openTime, closeTime, isClosed, isWeekend });
  }

  try {
    await db.transaction(async (tx) => {
      for (const day of days) {
        await tx
          .insert(clinicSchedule)
          .values({
            clinicId,
            dayOfWeek: day.dayOfWeek,
            openTime: day.openTime,
            closeTime: day.closeTime,
            isClosed: day.isClosed,
            isWeekend: day.isWeekend,
          })
          .onConflictDoUpdate({
            target: [clinicSchedule.clinicId, clinicSchedule.dayOfWeek],
            set: {
              openTime: day.openTime,
              closeTime: day.closeTime,
              isClosed: day.isClosed,
              isWeekend: day.isWeekend,
            },
          });
      }
    });

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_settings",
      entityId: clinicId,
      after: { schedule: days },
    });

    revalidatePath("/settings/schedule");
    revalidatePath("/appointments/agenda");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour des horaires"] } };
  }
}

export async function updateDentistMinGap(
  dentistUserId: string,
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  void prevState;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "settings:clinic_manage"))) {
    return { success: false, error: { general: ["Seul le propriétaire peut modifier les horaires"] } };
  }

  const rawMinutes = String(formData.get("minutes") ?? "");
  const minutes = rawMinutes.trim() === "" ? 15 : Number(rawMinutes);

  if (!Number.isInteger(minutes) || minutes < 0) {
    return { success: false, error: { general: ["Délai invalide : nombre entier de minutes supérieur ou égal à 0"] } };
  }

  try {
    const target = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.userId, dentistUserId),
        eq(clinicMemberships.clinicId, clinicId),
      ),
    });

    if (!target || !isPractitionerRole(target.role)) {
      return { success: false, error: { general: ["Dentiste introuvable"] } };
    }

    await db
      .update(clinicMemberships)
      .set({ minGapMinutes: minutes })
      .where(
        and(
          eq(clinicMemberships.userId, dentistUserId),
          eq(clinicMemberships.clinicId, clinicId),
        ),
      );

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinic_membership",
      entityId: `${clinicId}:${dentistUserId}`,
      before: { minGapMinutes: target.minGapMinutes },
      after: { minGapMinutes: minutes },
    });

    revalidatePath("/settings/schedule");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour du délai"] } };
  }
}
