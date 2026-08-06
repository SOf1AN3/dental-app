"use server";

import { db } from "@/lib/db/db";
import { clinics, clinicMemberships } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

const createClinicSchema = z.object({
  name: z.string().min(2, "Le nom doit contenir au moins 2 caractères"),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "Slug invalide (lettres minuscules, chiffres, tirets)"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  wilayaCode: z.string().optional().or(z.literal("")),
});

export async function createClinic(formData: FormData) {
  const user = await requireAuth();

  const validated = createClinicSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    address: formData.get("address"),
    wilayaCode: formData.get("wilayaCode"),
  });

  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const existingSlug = await db.query.clinics.findFirst({
      where: eq(clinics.slug, data.slug),
    });

    if (existingSlug) {
      return { error: { slug: ["Ce slug est déjà utilisé"] } };
    }

    const [clinic] = await db.insert(clinics).values({
      name: data.name,
      slug: data.slug,
      email: data.email || null,
      phone: data.phone || null,
      address: data.address || null,
      wilayaCode: data.wilayaCode || null,
    }).returning();

    await db.insert(clinicMemberships).values({
      userId: user.id,
      clinicId: clinic.id,
      role: "owner",
      joinedAt: new Date(),
    });

    const cookieStore = await cookies();
    cookieStore.set("active_clinic_id", clinic.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    await logAction({
      clinicId: clinic.id,
      action: "create",
      entityType: "clinic",
      entityId: clinic.id,
      after: {
        name: data.name,
        slug: data.slug,
        email: data.email || null,
        phone: data.phone || null,
        address: data.address || null,
        wilayaCode: data.wilayaCode || null,
      },
    });

    revalidatePath("/select-clinic");
    redirect("/");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    console.error("[createClinic] Erreur inattendue:", e);
    return { error: { general: ["Erreur lors de la création de la clinique"] } };
  }
}

export async function switchClinic(
  clinicId: string,
): Promise<void> {
  const user = await requireAuth();

  try {
    const membership = await db.query.clinicMemberships.findFirst({
      where: (memberships, { and, eq }) => and(
        eq(memberships.userId, user.id),
        eq(memberships.clinicId, clinicId)
      ),
    });

    if (!membership) {
      return;
    }

    const cookieStore = await cookies();
    cookieStore.set("active_clinic_id", clinicId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    revalidatePath("/");
    redirect("/");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
  }
}
