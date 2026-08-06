"use server";

import { db } from "@/lib/db/db";
import {
  invoices,
  invoiceItems,
  quotes,
  quoteItems,
  payments,
  patients,
  documentSequences,
  clinicalSessions,
} from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow, getCurrentUser } from "@/lib/auth-utils";
import {
  eq,
  and,
  desc,
  inArray,
  sql,
  count,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

export async function getInvoices(status?: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const conditions = [eq(invoices.clinicId, clinicId)];
  if (status) {
    conditions.push(eq(invoices.status, status as "draft" | "sent" | "paid" | "partially_paid" | "overdue" | "cancelled"));
  }

  try {
    return await db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.createdAt));
  } catch {
    return [];
  }
}

export async function getInvoice(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const invoice = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.clinicId, clinicId)),
      with: {
        patient: true,
        items: true,
        payments: true,
      },
    });

    return invoice;
  } catch {
    return null;
  }
}

export async function getInvoicesSummary() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const rows = await db
      .select({
        totalCount: count(),
        totalAmount: sql<number>`COALESCE(SUM(${invoices.total}), 0)::float8`,
        pendingAmount:
          sql<number>`COALESCE(SUM(CASE WHEN ${invoices.status} IN ('draft', 'sent', 'partially_paid', 'overdue') THEN ${invoices.total} ELSE 0 END), 0)::float8`,
      })
      .from(invoices)
      .where(eq(invoices.clinicId, clinicId));

    return rows[0] || { totalCount: 0, totalAmount: 0, pendingAmount: 0 };
  } catch {
    return { totalCount: 0, totalAmount: 0, pendingAmount: 0 };
  }
}

export async function getQuotes(status?: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const conditions = [eq(quotes.clinicId, clinicId)];
  if (status && status !== "all") {
    conditions.push(eq(quotes.status, status as "draft" | "sent" | "accepted" | "rejected" | "expired"));
  }

  try {
    const rows = await db
      .select()
      .from(quotes)
      .where(and(...conditions))
      .orderBy(desc(quotes.createdAt));

    const patientIds = [...new Set(rows.map((r) => r.patientId))];
    const patientRows = patientIds.length > 0
      ? await db
          .select({ id: patients.id, firstName: patients.firstName, lastName: patients.lastName })
          .from(patients)
          .where(inArray(patients.id, patientIds))
      : [];

    const patientMap = Object.fromEntries(
      patientRows.map((p) => [p.id, p]),
    );

    return rows.map((r) => ({
      ...r,
      patient: patientMap[r.patientId] || null,
    }));
  } catch {
    return [];
  }
}

export async function getQuote(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [quote] = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, id), eq(quotes.clinicId, clinicId)))
      .limit(1);

    if (!quote) return null;

    const items = await db
      .select()
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, id));

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.id, quote.patientId))
      .limit(1);

    return { ...quote, items, patient: patient || null };
  } catch {
    return null;
  }
}

const quoteSchema = z.object({
  patientId: z.string().min(1, "Patient requis"),
  date: z.string().min(1, "Date requise"),
  validUntil: z.string().optional().default("").catch(""),
  notes: z.string().optional().default("").catch(""),
});

export async function createQuote(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = quoteSchema.safeParse(Object.fromEntries(formData));
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
      type: "quote",
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
        eq(documentSequences.type, "quote"),
      ),
    )
    .returning();

  const nextNumber = seq?.lastNumber ?? 1;
  const number = `DEV-${year}-${String(nextNumber).padStart(4, "0")}`;

  const itemsRaw = formData.get("items") as string;
  let items: Array<{ description: string; quantity: number; unitPrice: number; taxRate: number; total: number }> = [];
  if (itemsRaw) {
    try {
      items = JSON.parse(itemsRaw);
    } catch {
      // Invalid JSON, ignore
    }
  }

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);

  try {
    const [quote] = await db.insert(quotes).values({
      clinicId,
      patientId: data.patientId,
      number,
      date: new Date(data.date),
      validUntil: data.validUntil ? new Date(data.validUntil) : null,
      status: "draft",
      subtotal,
      taxTotal: 0,
      discountTotal: 0,
      total: subtotal,
      notes: data.notes || null,
    }).returning();

    if (quote && items.length > 0) {
      await db.insert(quoteItems).values(
        items.map((item) => ({
          quoteId: quote.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate || 0,
          total: item.total,
        }))
      );
    }

    await logAction({
      clinicId,
      action: "create",
      entityType: "quote",
      entityId: quote.id,
      after: {
        patientId: data.patientId,
        number,
        status: "draft",
        subtotal,
        total: subtotal,
        notes: data.notes || null,
        itemCount: items.length,
      },
    });

    revalidatePath("/billing/quotes");
    redirect("/billing/quotes");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création du devis"] } };
  }
}

export async function updateQuoteStatus(
  quoteId: string,
  status: "draft" | "sent" | "accepted" | "rejected" | "expired",
  _formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const [quote] = await db
    .select({ id: quotes.id, status: quotes.status })
    .from(quotes)
    .where(and(eq(quotes.id, quoteId), eq(quotes.clinicId, clinicId)))
    .limit(1);

  await db
    .update(quotes)
    .set({ status })
    .where(and(eq(quotes.id, quoteId), eq(quotes.clinicId, clinicId)));

  if (quote) {
    await logAction({
      clinicId,
      action: "status_change",
      entityType: "quote",
      entityId: quoteId,
      before: { status: quote.status },
      after: { status },
    });
  }

  revalidatePath(`/billing/quotes/${quoteId}`);
  revalidatePath("/billing/quotes");
}

const invoiceSchema = z.object({
  patientId: z.string().min(1, "Patient requis"),
  date: z.string().min(1, "Date requise"),
  dueDate: z.string().optional().default("").catch(""),
  notes: z.string().optional().default("").catch(""),
});

export async function createInvoice(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = invoiceSchema.safeParse(Object.fromEntries(formData));
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
      type: "invoice",
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
        eq(documentSequences.type, "invoice"),
      ),
    )
    .returning();

  const nextNumber = seq?.lastNumber ?? 1;
  const number = `FAC-${year}-${String(nextNumber).padStart(5, "0")}`;

  const itemsRaw = formData.get("items") as string;
  let items: Array<{ description: string; quantity: number; unitPrice: number; taxRate: number; total: number }> = [];
  if (itemsRaw) {
    try {
      items = JSON.parse(itemsRaw);
    } catch {
      // Invalid JSON, ignore
    }
  }

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);

  try {
    const [invoice] = await db.insert(invoices).values({
      clinicId,
      patientId: data.patientId,
      number,
      date: new Date(data.date),
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      status: "draft",
      subtotal,
      total: subtotal,
      notes: data.notes || null,
    }).returning();

    if (invoice && items.length > 0) {
      await db.insert(invoiceItems).values(
        items.map((item) => ({
          invoiceId: invoice.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate || 0,
          total: item.total,
        }))
      );
    }

    await logAction({
      clinicId,
      action: "create",
      entityType: "invoice",
      entityId: invoice.id,
      after: {
        patientId: data.patientId,
        number,
        status: "draft",
        subtotal,
        total: subtotal,
        notes: data.notes || null,
        itemCount: items.length,
      },
    });

    revalidatePath("/billing/invoices");
    redirect("/billing/invoices");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création de la facture"] } };
  }
}

const updateStatusSchema = z.object({
  status: z.enum([
    "draft",
    "sent",
    "paid",
    "partially_paid",
    "overdue",
    "cancelled",
  ]),
});

export async function updateInvoiceStatus(
  invoiceId: string,
  prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = updateStatusSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: "Statut invalide" };
  }

  try {
    const [invoice] = await db
      .select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.clinicId, clinicId)))
      .limit(1);

    await db
      .update(invoices)
      .set({ status: validated.data.status })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.clinicId, clinicId)));

    if (invoice) {
      await logAction({
        clinicId,
        action: "status_change",
        entityType: "invoice",
        entityId: invoiceId,
        before: { status: invoice.status },
        after: { status: validated.data.status },
      });
    }

    revalidatePath(`/billing/invoices/${invoiceId}`);
    revalidatePath("/billing/invoices");

    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du statut" };
  }
}

const paymentSchema = z.object({
  amount: z.string().min(1, "Montant requis"),
  method: z.enum(["cash", "check", "card", "transfer"]),
  reference: z.string().optional().default("").catch(""),
  date: z.string().min(1, "Date requise"),
  notes: z.string().optional().default("").catch(""),
});

export async function recordPayment(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = paymentSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const amount = Math.round(parseFloat(data.amount) * 100) / 100;

  if (amount <= 0) {
    return { error: { amount: ["Le montant doit être supérieur à zéro"] } };
  }

  const invoiceId = formData.get("invoiceId") as string | null;
  const user = await getCurrentUser();
  let sessionRedirectPath: string | null = null;

  try {
    const [payment] = await db.insert(payments).values({
      clinicId,
      patientId,
      invoiceId: invoiceId || null,
      amount,
      method: data.method,
      reference: data.reference || null,
      date: new Date(data.date),
      notes: data.notes || null,
      createdBy: user?.id ?? null,
    }).returning({ id: payments.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "payment",
      entityId: payment.id,
      after: {
        patientId,
        invoiceId: invoiceId || null,
        amount,
        method: data.method,
        reference: data.reference || null,
        date: new Date(data.date).toISOString(),
      },
    });

    if (invoiceId) {
      const invoicePayments = await db
        .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::float8` })
        .from(payments)
        .where(eq(payments.invoiceId, invoiceId));

      const invoice = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .then((r) => r[0]);

      if (invoice) {
        const paidAmount = invoicePayments[0]?.total || 0;
        let newStatus: "paid" | "partially_paid" | "draft" | "sent" | "overdue" | "cancelled";
        if (paidAmount >= invoice.total) {
          newStatus = "paid";
        } else if (paidAmount > 0) {
          newStatus = "partially_paid";
        } else {
          newStatus = invoice.status;
        }

        await db
          .update(invoices)
          .set({ status: newStatus })
          .where(eq(invoices.id, invoiceId));

        if (newStatus === "paid" && invoice.sessionId) {
          await db
            .update(clinicalSessions)
            .set({ status: "paid" })
            .where(eq(clinicalSessions.id, invoice.sessionId));
          revalidatePath(`/patients/${invoice.patientId}/session/${invoice.sessionId}`);
        }

        if (invoice.sessionId) {
          sessionRedirectPath = `/patients/${invoice.patientId}/session/${invoice.sessionId}`;
        }
      }

      revalidatePath(`/billing/invoices/${invoiceId}`);
    }

    revalidatePath("/billing/invoices");
    redirect(sessionRedirectPath ?? "/billing/invoices");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de l'enregistrement du paiement"] } };
  }
}
