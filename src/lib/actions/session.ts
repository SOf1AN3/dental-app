"use server";

import { db } from "@/lib/db/db";
import {
  clinicalSessions,
  clinicalSessionItems,
  waitingRoomEntries,
  documentSequences,
  invoices,
  invoiceItems,
  patients,
  prescriptions,
  prescriptionItems,
  payments,
  appointments,
} from "@/lib/db/schema";
import { getCurrentClinicId, requireClinicAccess } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";
import {
  isSessionStatusTransitionAllowed,
  sessionItemTotal,
  sessionSubtotal,
} from "@/lib/session-rules";

type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SessionData = typeof clinicalSessions.$inferSelect & {
  patient: typeof patients.$inferSelect | null;
  items: Array<typeof clinicalSessionItems.$inferSelect>;
  prescription: (typeof prescriptions.$inferSelect & {
    items: Array<typeof prescriptionItems.$inferSelect>;
  }) | null;
  invoice: (typeof invoices.$inferSelect & {
    items: Array<typeof invoiceItems.$inferSelect>;
    payments: Array<typeof payments.$inferSelect>;
  }) | null;
};

export async function callPatientFromWaitingRoom(entryId: string): Promise<void> {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const entry = await db.query.waitingRoomEntries.findFirst({
    where: and(
      eq(waitingRoomEntries.id, entryId),
      eq(waitingRoomEntries.clinicId, clinicId),
    ),
  });

  if (!entry) return;

  const existing = await db.query.clinicalSessions.findFirst({
    where: and(
      eq(clinicalSessions.patientId, entry.patientId),
      eq(clinicalSessions.clinicId, clinicId),
      eq(clinicalSessions.status, "in_progress"),
    ),
  });

  let sessionId: string;

  if (existing) {
    sessionId = existing.id;
  } else {
    const [created] = await db.insert(clinicalSessions).values({
      clinicId,
      patientId: entry.patientId,
      appointmentId: entry.appointmentId,
      dentistId: user.id,
      status: "in_progress",
      startedAt: new Date(),
    }).returning({ id: clinicalSessions.id });

    sessionId = created.id;

    await logAction({
      clinicId,
      action: "create",
      entityType: "clinical_session",
      entityId: sessionId,
      after: {
        patientId: entry.patientId,
        appointmentId: entry.appointmentId,
        dentistId: user.id,
        status: "in_progress",
      },
    });
  }

  await db
    .update(waitingRoomEntries)
    .set({ status: "called", calledAt: new Date() })
    .where(
      and(
        eq(waitingRoomEntries.id, entryId),
        eq(waitingRoomEntries.clinicId, clinicId),
      ),
    );

  await logAction({
    clinicId,
    action: "status_change",
    entityType: "waiting_room_entry",
    entityId: entryId,
    before: { status: entry.status },
    after: { status: "called" },
  });

  revalidatePath("/waiting-room");
  redirect(`/patients/${entry.patientId}/session/${sessionId}`);
}

export async function startOrResumeSession(patientId: string): Promise<void> {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const existing = await db.query.clinicalSessions.findFirst({
    where: and(
      eq(clinicalSessions.patientId, patientId),
      eq(clinicalSessions.clinicId, clinicId),
      eq(clinicalSessions.status, "in_progress"),
    ),
  });

  if (existing) {
    redirect(`/patients/${patientId}/session/${existing.id}`);
  }

  const [created] = await db.insert(clinicalSessions).values({
    clinicId,
    patientId,
    dentistId: user.id,
    status: "in_progress",
    startedAt: new Date(),
  }).returning({ id: clinicalSessions.id });

  await logAction({
    clinicId,
    action: "create",
    entityType: "clinical_session",
    entityId: created.id,
    after: { patientId, dentistId: user.id, status: "in_progress" },
  });

  redirect(`/patients/${patientId}/session/${created.id}`);
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const session = await db.query.clinicalSessions.findFirst({
    where: and(
      eq(clinicalSessions.id, sessionId),
      eq(clinicalSessions.clinicId, clinicId),
    ),
    with: { patient: true, prescription: true, invoice: true },
  });

  if (!session) return null;

  const items = await db
    .select()
    .from(clinicalSessionItems)
    .where(eq(clinicalSessionItems.sessionId, sessionId))
    .orderBy(asc(clinicalSessionItems.orderIndex));

  let prescription: SessionData["prescription"] = null;
  if (session.prescription) {
    const row = await db.query.prescriptions.findFirst({
      where: eq(prescriptions.id, session.prescription.id),
      with: { items: true },
    });
    prescription = row ?? null;
  }

  let invoice: SessionData["invoice"] = null;
  if (session.invoice) {
    const row = await db.query.invoices.findFirst({
      where: eq(invoices.id, session.invoice.id),
      with: { items: true, payments: true },
    });
    invoice = row ?? null;
  }

  return {
    ...session,
    patient: session.patient,
    items,
    prescription,
    invoice,
  };
}

export async function getSessions(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db.query.clinicalSessions.findMany({
      where: and(
        eq(clinicalSessions.patientId, patientId),
        eq(clinicalSessions.clinicId, clinicId),
      ),
      with: { patient: true, invoice: true },
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
  } catch {
    return [];
  }
}

export async function getActiveSession(
  patientId: string,
): Promise<{ id: string } | null> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const session = await db.query.clinicalSessions.findFirst({
    where: and(
      eq(clinicalSessions.patientId, patientId),
      eq(clinicalSessions.clinicId, clinicId),
      eq(clinicalSessions.status, "in_progress"),
    ),
    columns: { id: true },
  });

  return session ? { id: session.id } : null;
}

export async function recalculateSessionTotal(
  sessionId: string,
  tx?: DbOrTx,
): Promise<number> {
  const client = tx ?? db;

  const [row] = await client
    .select({
      total: sql<number>`COALESCE(SUM(${clinicalSessionItems.fee} * ${clinicalSessionItems.quantity} - COALESCE(${clinicalSessionItems.discount}, 0)), 0)::float8`,
    })
    .from(clinicalSessionItems)
    .where(eq(clinicalSessionItems.sessionId, sessionId));

  const total = Number(row?.total ?? 0);

  await client
    .update(clinicalSessions)
    .set({ totalAmount: total })
    .where(eq(clinicalSessions.id, sessionId));

  return total;
}

const clinicalSessionItemSchema = z.object({
  toothNumber: z.coerce.number().int().optional(),
  surface: z.string().optional().default("").catch(""),
  procedureCode: z.string().optional().default("").catch(""),
  description: z.string().min(1, "Description requise"),
  fee: z.coerce.number().min(0),
  quantity: z.coerce.number().int().positive().default(1),
  discount: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().int().default(0),
});

export async function createSessionItem(
  sessionId: string,
  prevState: { error?: Record<string, string[]> } | { success: true } | undefined,
  formData: FormData,
): Promise<{ error?: Record<string, string[]> } | { success: true }> {
  void prevState;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = clinicalSessionItemSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [session] = await db
      .select({ id: clinicalSessions.id, patientId: clinicalSessions.patientId })
      .from(clinicalSessions)
      .where(
        and(
          eq(clinicalSessions.id, sessionId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!session) {
      return { error: { general: ["Séance introuvable"] } };
    }

    let createdId: string | undefined;

    await db.transaction(async (tx) => {
      const [created] = await tx.insert(clinicalSessionItems).values({
        sessionId,
        toothNumber: data.toothNumber ?? null,
        surface: data.surface || null,
        procedureCode: data.procedureCode || null,
        description: data.description,
        fee: data.fee,
        quantity: data.quantity,
        discount: data.discount,
        taxRate: data.taxRate,
      }).returning({ id: clinicalSessionItems.id });

      createdId = created?.id;

      await recalculateSessionTotal(sessionId, tx);
    });

    if (createdId) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "clinical_session_item",
        entityId: createdId,
        after: { ...data, sessionId },
      });
    }

    revalidatePath(`/patients/${session.patientId}/session/${sessionId}`);
    revalidatePath(`/patients/${session.patientId}`);
    return { success: true };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de l'ajout de l'acte"] } };
  }
}

export async function updateSessionItem(
  itemId: string,
  prevState: { error?: Record<string, string[]> } | { success: true } | undefined,
  formData: FormData,
): Promise<{ error?: Record<string, string[]> } | { success: true }> {
  void prevState;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = clinicalSessionItemSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [item] = await db
      .select({
        id: clinicalSessionItems.id,
        sessionId: clinicalSessionItems.sessionId,
        patientId: clinicalSessions.patientId,
        toothNumber: clinicalSessionItems.toothNumber,
        surface: clinicalSessionItems.surface,
        procedureCode: clinicalSessionItems.procedureCode,
        description: clinicalSessionItems.description,
        fee: clinicalSessionItems.fee,
        quantity: clinicalSessionItems.quantity,
        discount: clinicalSessionItems.discount,
        taxRate: clinicalSessionItems.taxRate,
      })
      .from(clinicalSessionItems)
      .innerJoin(clinicalSessions, eq(clinicalSessionItems.sessionId, clinicalSessions.id))
      .where(
        and(
          eq(clinicalSessionItems.id, itemId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!item) {
      return { error: { general: ["Élément introuvable"] } };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(clinicalSessionItems)
        .set({
          toothNumber: data.toothNumber ?? null,
          surface: data.surface || null,
          procedureCode: data.procedureCode || null,
          description: data.description,
          fee: data.fee,
          quantity: data.quantity,
          discount: data.discount,
          taxRate: data.taxRate,
        })
        .where(eq(clinicalSessionItems.id, itemId));

      await recalculateSessionTotal(item.sessionId, tx);
    });

    await logAction({
      clinicId,
      action: "update",
      entityType: "clinical_session_item",
      entityId: itemId,
      before: {
        toothNumber: item.toothNumber ?? null,
        surface: item.surface ?? null,
        procedureCode: item.procedureCode ?? null,
        description: item.description,
        fee: item.fee,
        quantity: item.quantity,
        discount: item.discount,
        taxRate: item.taxRate,
      },
      after: { ...data, sessionId: item.sessionId },
    });

    revalidatePath(`/patients/${item.patientId}/session/${item.sessionId}`);
    revalidatePath(`/patients/${item.patientId}`);
    return { success: true };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la mise à jour de l'acte"] } };
  }
}

export async function deleteSessionItem(
  itemId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [item] = await db
      .select({
        id: clinicalSessionItems.id,
        sessionId: clinicalSessionItems.sessionId,
        patientId: clinicalSessions.patientId,
        description: clinicalSessionItems.description,
        fee: clinicalSessionItems.fee,
        quantity: clinicalSessionItems.quantity,
        procedureCode: clinicalSessionItems.procedureCode,
      })
      .from(clinicalSessionItems)
      .innerJoin(clinicalSessions, eq(clinicalSessionItems.sessionId, clinicalSessions.id))
      .where(
        and(
          eq(clinicalSessionItems.id, itemId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!item) {
      return { error: "Élément introuvable" };
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(clinicalSessionItems)
        .where(eq(clinicalSessionItems.id, itemId));

      await recalculateSessionTotal(item.sessionId, tx);
    });

    await logAction({
      clinicId,
      action: "delete",
      entityType: "clinical_session_item",
      entityId: itemId,
      before: {
        description: item.description,
        fee: item.fee,
        quantity: item.quantity,
        procedureCode: item.procedureCode ?? null,
      },
    });

    revalidatePath(`/patients/${item.patientId}/session/${item.sessionId}`);
    revalidatePath(`/patients/${item.patientId}`);
    return { success: true };
  } catch {
    return { error: "Erreur lors de la suppression" };
  }
}

export async function closeSession(
  sessionId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [session] = await db
      .select({
        id: clinicalSessions.id,
        patientId: clinicalSessions.patientId,
        status: clinicalSessions.status,
        appointmentId: clinicalSessions.appointmentId,
      })
      .from(clinicalSessions)
      .where(
        and(
          eq(clinicalSessions.id, sessionId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!session) {
      return { error: "Séance introuvable" };
    }

    if (session.status !== "in_progress") {
      return { error: "Séance déjà clôturée ou terminée" };
    }

    const items = await db
      .select()
      .from(clinicalSessionItems)
      .where(eq(clinicalSessionItems.sessionId, sessionId));

    if (items.length === 0) {
      return { error: "Ajoutez au moins un acte avant de clôturer la séance" };
    }

    const subtotal = sessionSubtotal(items);

    const now = new Date();
    const year = now.getFullYear();

    await db.transaction(async (tx) => {
      await tx
        .update(clinicalSessions)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(clinicalSessions.id, sessionId));

      // Ensure sequence row exists (ignore if already exists)
      await tx
        .insert(documentSequences)
        .values({
          clinicId,
          type: "invoice",
          lastNumber: 0,
        })
        .onConflictDoNothing();

      // Atomic increment
      const [seq] = await tx
        .update(documentSequences)
        .set({ lastNumber: sql`last_number + 1` })
        .where(
          and(
            eq(documentSequences.clinicId, clinicId),
            eq(documentSequences.type, "invoice"),
          ),
        )
        .returning();

      const nextNumber = seq?.lastNumber ?? 1;
      const number = `FAC-${year}-${String(nextNumber).padStart(5, "0")}`;

      const [invoice] = await tx
        .insert(invoices)
        .values({
          clinicId,
          patientId: session.patientId,
          sessionId,
          number,
          date: new Date(),
          status: "draft",
          subtotal,
          taxTotal: 0,
          discountTotal: 0,
          total: subtotal,
          notes: null,
        })
        .returning({ id: invoices.id });

      const invoiceId = invoice?.id;

      if (invoiceId) {
        await tx.insert(invoiceItems).values(
          items.map((item) => ({
            invoiceId,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.fee,
            taxRate: item.taxRate ?? 0,
            discount: item.discount ?? 0,
            total: sessionItemTotal(item.fee, item.quantity, item.discount ?? undefined),
          })),
        );

        await logAction({
          clinicId,
          action: "create",
          entityType: "invoice",
          entityId: invoiceId,
          after: {
            patientId: session.patientId,
            sessionId,
            number,
            status: "draft",
            subtotal,
            total: subtotal,
            itemCount: items.length,
          },
        });
      }

      await logAction({
        clinicId,
        action: "status_change",
        entityType: "clinical_session",
        entityId: sessionId,
        before: { status: "in_progress" },
        after: { status: "completed" },
      });

      if (session.appointmentId) {
        const [appointment] = await tx
          .select({ id: appointments.id, status: appointments.status })
          .from(appointments)
          .where(
            and(
              eq(appointments.id, session.appointmentId),
              eq(appointments.clinicId, clinicId),
            ),
          )
          .limit(1);

        if (appointment && (appointment.status === "confirmed" || appointment.status === "in_progress")) {
          await tx
            .update(appointments)
            .set({ status: "completed" })
            .where(eq(appointments.id, appointment.id));

          await logAction({
            clinicId,
            action: "status_change",
            entityType: "appointment",
            entityId: appointment.id,
            before: { status: appointment.status },
            after: { status: "completed" },
          });
        }
      }
    });

    revalidatePath(`/patients/${session.patientId}/session/${sessionId}`);
    revalidatePath("/billing/invoices");
    revalidatePath("/appointments");
    return { success: true };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: "Erreur lors de la clôture de la séance" };
  }
}

export async function updateSessionStatus(
  sessionId: string,
  status: "completed" | "invoiced" | "paid",
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [session] = await db
      .select({
        id: clinicalSessions.id,
        patientId: clinicalSessions.patientId,
        status: clinicalSessions.status,
      })
      .from(clinicalSessions)
      .where(
        and(
          eq(clinicalSessions.id, sessionId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!session) {
      return { error: "Séance introuvable" };
    }

    if (status === session.status) {
      return { success: true };
    }

    if (!isSessionStatusTransitionAllowed(session.status, status)) {
      return { error: "Transition de statut non autorisée" };
    }

    let invoiceId: string | null = null;

    await db.transaction(async (tx) => {
      await tx
        .update(clinicalSessions)
        .set({ status })
        .where(eq(clinicalSessions.id, sessionId));

      if (status === "invoiced" || status === "paid") {
        const [invoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.sessionId, sessionId),
              eq(invoices.clinicId, clinicId),
            ),
          )
          .limit(1);

        if (invoice) {
          invoiceId = invoice.id;
          await tx
            .update(invoices)
            .set({ status: status === "invoiced" ? "sent" : "paid" })
            .where(eq(invoices.id, invoice.id));
        }
      }
    });

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "clinical_session",
      entityId: sessionId,
      before: { status: session.status },
      after: { status },
    });

    revalidatePath(`/patients/${session.patientId}/session/${sessionId}`);
    revalidatePath(`/patients/${session.patientId}`);
    revalidatePath("/billing/invoices");
    if (invoiceId) {
      revalidatePath(`/billing/invoices/${invoiceId}`);
    }

    return { success: true };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: "Erreur lors de la mise à jour du statut" };
  }
}

export async function deleteSession(
  sessionId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  const { user, membership } = await requireClinicAccess(clinicId);

  try {
    const [session] = await db
      .select({
        id: clinicalSessions.id,
        patientId: clinicalSessions.patientId,
        dentistId: clinicalSessions.dentistId,
        status: clinicalSessions.status,
      })
      .from(clinicalSessions)
      .where(
        and(
          eq(clinicalSessions.id, sessionId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!session) {
      return { error: "Séance introuvable" };
    }

    if (session.status !== "in_progress") {
      return { error: "Seules les séances en cours peuvent être supprimées" };
    }

    if (session.dentistId !== user.id && membership.role !== "owner") {
      return { error: "Vous n'êtes pas autorisé à supprimer cette séance" };
    }

    const [invoice] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.sessionId, sessionId),
          eq(invoices.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (invoice) {
      return { error: "Impossible de supprimer une séance facturée" };
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(waitingRoomEntries)
        .where(
          and(
            eq(waitingRoomEntries.clinicId, clinicId),
            eq(waitingRoomEntries.patientId, session.patientId),
            inArray(waitingRoomEntries.status, [
              "waiting",
              "called",
              "in_treatment",
            ]),
          ),
        );

      await tx
        .delete(clinicalSessions)
        .where(eq(clinicalSessions.id, sessionId));
    });

    await logAction({
      clinicId,
      action: "delete",
      entityType: "clinical_session",
      entityId: sessionId,
      before: {
        patientId: session.patientId,
        dentistId: session.dentistId ?? null,
        status: session.status,
      },
    });

    revalidatePath(`/patients/${session.patientId}/sessions`);
    revalidatePath(`/patients/${session.patientId}`);
    revalidatePath("/waiting-room");

    return { success: true };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: "Erreur lors de la suppression de la séance" };
  }
}
