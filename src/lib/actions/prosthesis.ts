"use server";

import { db } from "@/lib/db/db";
import { prosthesisLabs, prosthesisOrders, patients, documentSequences } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { and, eq, asc, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

const labSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  contactPerson: z.string().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

const orderSchema = z.object({
  patientId: z.string().min(1, "Patient requis"),
  labId: z.string().optional().or(z.literal("")),
  description: z.string().min(1, "Description requise"),
  toothNumber: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z.number().int("Numéro de dent invalide").optional(),
  ),
  material: z.string().optional().or(z.literal("")),
  color: z.string().optional().or(z.literal("")),
  deliveryDate: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : new Date(v as string)),
    z.date().optional(),
  ),
  cost: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(0).optional(),
  ),
  notes: z.string().optional().or(z.literal("")),
});

const validStatuses = ["ordered", "in_progress", "delivered", "cancelled"] as const;

export async function getLabs() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(prosthesisLabs)
      .where(eq(prosthesisLabs.clinicId, clinicId))
      .orderBy(asc(prosthesisLabs.name));
  } catch {
    return [];
  }
}

export async function getLab(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [lab] = await db
      .select()
      .from(prosthesisLabs)
      .where(and(eq(prosthesisLabs.id, id), eq(prosthesisLabs.clinicId, clinicId)));

    return lab || null;
  } catch {
    return null;
  }
}

export async function createLab(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = labSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [created] = await db.insert(prosthesisLabs).values({
      clinicId,
      name: data.name,
      contactPerson: data.contactPerson || null,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      notes: data.notes || null,
    }).returning({ id: prosthesisLabs.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "prosthesis_lab",
      entityId: created.id,
      after: {
        name: data.name,
        contactPerson: data.contactPerson || null,
        phone: data.phone || null,
        email: data.email || null,
      },
    });

    revalidatePath("/prostheses");
    revalidatePath("/prostheses/labs");
    redirect("/prostheses");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création du laboratoire"] } };
  }
}

export async function updateLab(
  labId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = labSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        name: prosthesisLabs.name,
        contactPerson: prosthesisLabs.contactPerson,
        phone: prosthesisLabs.phone,
        email: prosthesisLabs.email,
        address: prosthesisLabs.address,
        notes: prosthesisLabs.notes,
      })
      .from(prosthesisLabs)
      .where(and(eq(prosthesisLabs.id, labId), eq(prosthesisLabs.clinicId, clinicId)))
      .limit(1);

    await db
      .update(prosthesisLabs)
      .set({
        name: data.name,
        contactPerson: data.contactPerson || null,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        notes: data.notes || null,
      })
      .where(and(eq(prosthesisLabs.id, labId), eq(prosthesisLabs.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "update",
      entityType: "prosthesis_lab",
      entityId: labId,
      before: current ? {
        name: current.name,
        contactPerson: current.contactPerson ?? null,
        phone: current.phone ?? null,
        email: current.email ?? null,
      } : undefined,
      after: {
        name: data.name,
        contactPerson: data.contactPerson || null,
        phone: data.phone || null,
        email: data.email || null,
      },
    });

    revalidatePath("/prostheses");
    revalidatePath("/prostheses/labs");
    revalidatePath(`/prostheses/labs/${labId}`);
    redirect("/prostheses");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la mise à jour du laboratoire"] } };
  }
}

export async function deleteLab(
  labId: string,
  formData: FormData,
): Promise<void> {
  void formData;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [current] = await db
      .select({ name: prosthesisLabs.name })
      .from(prosthesisLabs)
      .where(and(eq(prosthesisLabs.id, labId), eq(prosthesisLabs.clinicId, clinicId)))
      .limit(1);

    await db
      .delete(prosthesisLabs)
      .where(and(eq(prosthesisLabs.id, labId), eq(prosthesisLabs.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "prosthesis_lab",
      entityId: labId,
      before: { name: current?.name ?? null },
    });

    revalidatePath("/prostheses");
    revalidatePath("/prostheses/labs");
    redirect("/prostheses");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return;
  }
}

export async function getOrders(patientId?: string, labId?: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const conditions = [eq(prosthesisOrders.clinicId, clinicId)];

  if (patientId) {
    conditions.push(eq(prosthesisOrders.patientId, patientId));
  }
  if (labId) {
    conditions.push(eq(prosthesisOrders.labId, labId));
  }

  try {
    const results = await db
      .select({
        order: prosthesisOrders,
        patient: patients,
        lab: prosthesisLabs,
      })
      .from(prosthesisOrders)
      .innerJoin(patients, eq(prosthesisOrders.patientId, patients.id))
      .leftJoin(prosthesisLabs, eq(prosthesisOrders.labId, prosthesisLabs.id))
      .where(and(...conditions))
      .orderBy(desc(prosthesisOrders.createdAt));

    return results;
  } catch {
    return [];
  }
}

export async function getOrder(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [result] = await db
      .select({
        order: prosthesisOrders,
        patient: patients,
        lab: prosthesisLabs,
      })
      .from(prosthesisOrders)
      .innerJoin(patients, eq(prosthesisOrders.patientId, patients.id))
      .leftJoin(prosthesisLabs, eq(prosthesisOrders.labId, prosthesisLabs.id))
      .where(
        and(
          eq(prosthesisOrders.id, id),
          eq(prosthesisOrders.clinicId, clinicId),
        ),
      );

    return result || null;
  } catch {
    return null;
  }
}

export async function getLabOrders(labId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const results = await db
      .select({
        order: prosthesisOrders,
        patient: patients,
      })
      .from(prosthesisOrders)
      .innerJoin(patients, eq(prosthesisOrders.patientId, patients.id))
      .where(
        and(
          eq(prosthesisOrders.clinicId, clinicId),
          eq(prosthesisOrders.labId, labId),
        ),
      )
      .orderBy(desc(prosthesisOrders.createdAt));

    return results;
  } catch {
    return [];
  }
}

export async function createOrder(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = orderSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const now = new Date();
  const year = now.getFullYear();

  // Ensure sequence row exists (ignore if already exists)
  try {
    await db.insert(documentSequences).values({
      clinicId,
      type: "prosthesis",
      lastNumber: 0,
    });
  } catch {
    // Row already exists, ignore
  }

  // Atomic increment
  const [seq] = await db
    .update(documentSequences)
    .set({ lastNumber: sql`last_number + 1` })
    .where(
      and(
        eq(documentSequences.clinicId, clinicId),
        eq(documentSequences.type, "prosthesis"),
      ),
    )
    .returning();

  const nextNumber = seq?.lastNumber ?? 1;
  const orderNumber = `PRO-${year}-${String(nextNumber).padStart(5, "0")}`;

  try {
    const [created] = await db.insert(prosthesisOrders).values({
      clinicId,
      patientId: data.patientId,
      labId: data.labId || null,
      orderNumber,
      description: data.description,
      toothNumber: data.toothNumber ?? null,
      material: data.material || null,
      color: data.color || null,
      deliveryDate: data.deliveryDate ?? null,
      cost: data.cost ?? null,
      notes: data.notes || null,
    }).returning({ id: prosthesisOrders.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "prosthesis_order",
      entityId: created.id,
      after: {
        patientId: data.patientId,
        labId: data.labId || null,
        orderNumber,
        description: data.description,
        material: data.material || null,
        cost: data.cost ?? null,
        status: "ordered",
      },
    });

    revalidatePath("/prostheses");
    revalidatePath(`/patients/${data.patientId}`);
    redirect("/prostheses");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création de la commande"] } };
  }
}

export async function updateOrderStatus(
  orderId: string,
  status: string,
): Promise<void> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!validStatuses.includes(status as typeof validStatuses[number])) {
    return;
  }

  try {
    const [current] = await db
      .select({ id: prosthesisOrders.id, status: prosthesisOrders.status })
      .from(prosthesisOrders)
      .where(and(eq(prosthesisOrders.id, orderId), eq(prosthesisOrders.clinicId, clinicId)))
      .limit(1);

    await db
      .update(prosthesisOrders)
      .set({ status: status as typeof validStatuses[number] })
      .where(and(eq(prosthesisOrders.id, orderId), eq(prosthesisOrders.clinicId, clinicId)));

    if (current) {
      await logAction({
        clinicId,
        action: "status_change",
        entityType: "prosthesis_order",
        entityId: orderId,
        before: { status: current.status },
        after: { status: status as typeof validStatuses[number] },
      });
    }

    revalidatePath("/prostheses");
    revalidatePath(`/prostheses/orders/${orderId}`);
  } catch {
    return;
  }
}

export async function updateOrder(
  orderId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = orderSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [current] = await db
      .select({
        patientId: prosthesisOrders.patientId,
        labId: prosthesisOrders.labId,
        description: prosthesisOrders.description,
        toothNumber: prosthesisOrders.toothNumber,
        material: prosthesisOrders.material,
        color: prosthesisOrders.color,
        deliveryDate: prosthesisOrders.deliveryDate,
        cost: prosthesisOrders.cost,
        notes: prosthesisOrders.notes,
      })
      .from(prosthesisOrders)
      .where(and(eq(prosthesisOrders.id, orderId), eq(prosthesisOrders.clinicId, clinicId)))
      .limit(1);

    await db
      .update(prosthesisOrders)
      .set({
        patientId: data.patientId,
        labId: data.labId || null,
        description: data.description,
        toothNumber: data.toothNumber ?? null,
        material: data.material || null,
        color: data.color || null,
        deliveryDate: data.deliveryDate ?? null,
        cost: data.cost ?? null,
        notes: data.notes || null,
      })
      .where(and(eq(prosthesisOrders.id, orderId), eq(prosthesisOrders.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "update",
      entityType: "prosthesis_order",
      entityId: orderId,
      before: current ? {
        patientId: current.patientId,
        labId: current.labId ?? null,
        description: current.description,
        material: current.material ?? null,
        cost: current.cost ?? null,
      } : undefined,
      after: {
        patientId: data.patientId,
        labId: data.labId || null,
        description: data.description,
        material: data.material || null,
        cost: data.cost ?? null,
      },
    });

    revalidatePath("/prostheses");
    revalidatePath(`/prostheses/orders/${orderId}`);
    redirect("/prostheses");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la mise à jour de la commande"] } };
  }
}
