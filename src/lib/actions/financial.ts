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
import { requireAuth, requireClinicAccessOrThrow, getCurrentUser, hasAbility } from "@/lib/auth-utils";
import {
  eq,
  and,
  desc,
  inArray,
  isNull,
  sql,
  count,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { docTotals, lineTotal, recalcInvoiceStatus } from "@/lib/billing-math";
import { isRedirectOrReject } from "./errors";
import { requireOwnedPatient, requirePatientOwnership } from "@/lib/guards";

/**
 * Line items arrive as JSON from the browser; they are validated here and ALL
 * monetary amounts are recomputed server-side via billing-math (FACT-5).
 * The client's hidden total/subtotal inputs are never trusted.
 */
const lineItemSchema = z.object({
  description: z.string().trim().min(1, "Description requise"),
  quantity: z.coerce
    .number()
    .int("La quantité doit être un entier")
    .positive("La quantité doit être positive"),
  unitPrice: z.coerce.number().min(0, "Le prix unitaire doit être positif"),
  taxRate: z.coerce.number().int().min(0).max(100).catch(0),
  discount: z.coerce.number().min(0).catch(0),
});

const lineItemsSchema = z.array(lineItemSchema).min(1, "Ajoutez au moins une ligne");

type LineItemInput = z.infer<typeof lineItemSchema>;

function parseLineItems(
  raw: FormDataEntryValue | null,
): { ok: true; items: LineItemInput[] } | { ok: false } {
  if (!raw || typeof raw !== "string") return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const result = lineItemsSchema.safeParse(parsed);
  return result.success ? { ok: true, items: result.data } : { ok: false };
}

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
        items: true,
        // Filtre multi-tenant sur la table jointe : sans `eq(payments.clinicId, …)`,
        // la jointure retournerait les paiements d'une autre clinique.
        payments: {
          where: eq(payments.clinicId, clinicId),
        },
      },
    });
    if (!invoice) return null;

    // La relation `patient` ne peut pas porter `where` (Drizzle n'accepte que
    // columns/with/extras sur une relation `one`) : on la relit avec le filtre
    // multi-tenant. Patient d'une autre clinique → facture illisible (null → 404).
    const [patient] = await db
      .select()
      .from(patients)
      .where(and(eq(patients.id, invoice.patientId), eq(patients.clinicId, clinicId)))
      .limit(1);
    if (!patient) return null;

    return { ...invoice, patient };
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
          .where(and(inArray(patients.id, patientIds), eq(patients.clinicId, clinicId)))
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
      .where(and(eq(patients.id, quote.patientId), eq(patients.clinicId, clinicId)))
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
): Promise<{ error?: Record<string, string[]> }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    return { error: { general: ["Seuls la réception et le propriétaire peuvent gérer les devis"] } };
  }

  const validated = quoteSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Garde d'appartenance : `patientId` provient du formulaire. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé. Placé APRÈS l'authentification
  // et AVANT toute écriture (incrémentation de séquence + INSERT du devis).
  try {
    await requireOwnedPatient(clinicId, data.patientId);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique, inexistant ou archivé) :
    // remontée telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la création du devis"] } };
  }

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

  const itemsParsed = parseLineItems(formData.get("items"));
  if (!itemsParsed.ok) {
    return { error: { items: ["Lignes de devis invalides : vérifiez descriptions, quantités et prix"] } };
  }
  const items = itemsParsed.items;

  const totals = docTotals(items);

  // Z-20 : le devis, ses lignes et l'audit sont écrits dans UNE transaction.
  // Sans elle, un échec du second INSERT survenait APRÈS
  // l'engagement du devis : le `catch` renvoyait « Erreur lors de la création »
  // alors que le devis existait déjà → devis orphelin sans lignes, ou double
  // devis après relance du formulaire. Même pattern que `convertQuoteToInvoice`
  // et `closeSession` (`db.transaction` + `tx.insert`).
  try {
    await db.transaction(async (tx) => {
      const [quote] = await tx.insert(quotes).values({
        clinicId,
        patientId: data.patientId,
        number,
        date: new Date(data.date),
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        status: "draft",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        discountTotal: totals.discountTotal,
        total: totals.total,
        notes: data.notes || null,
      }).returning();

      if (quote && items.length > 0) {
        await tx.insert(quoteItems).values(
          items.map((item) => ({
            quoteId: quote.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRate: item.taxRate,
            discount: item.discount,
            total: lineTotal(item),
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
          ...totals,
          notes: data.notes || null,
          itemCount: items.length,
        },
      });
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

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    throw new Error("Action non autorisée sur les devis");
  }

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

/**
 * FACT-1 — Convert an ACCEPTED quote into a draft invoice, atomically:
 * sequence increment, invoice + copied items and the quote↔invoice link all
 * happen inside one transaction.
 *
 * Double conversion is prevented by two complementary locks (Z-22):
 * 1. the in-transaction read is a `SELECT … FOR UPDATE`, so a concurrent
 *    conversion blocks on the quote row and, once the winner commits, reads
 *    `convertedInvoiceId` already set → "Devis déjà facturé";
 * 2. the link write is a conditional claim —
 *    `UPDATE … SET converted_invoice_id = $1 WHERE … AND converted_invoice_id IS NULL`
 *    — whose affected-row count is checked: 0 rows → throw → the whole
 *    transaction (invoice + items + sequence) is rolled back.
 * The JS `convertedInvoiceId` read below is only a fast-path guard; the two
 * statements above are the actual concurrency control.
 */
export async function convertQuoteToInvoice(
  quoteId: string,
  prevState: { error?: string; success?: boolean; invoiceId?: string } | undefined,
  _formData: FormData,
): Promise<{ error?: string } | { success?: boolean; invoiceId?: string }> {
  void prevState;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    return { error: "Seuls la réception et le propriétaire peuvent facturer un devis" };
  }

  const user = await getCurrentUser();

  try {
    // Garde d'appartenance DEFENSIVE : `patientId` n'est pas un argument client
    // (il provient de la ligne devis, déjà filtrée par `clinicId`, et aucune action
    // ne modifie `quotes.patientId`). Mais les devis créés AVANT la validation de
    // `createQuote` peuvent porter un `patientId` étranger : sans ce garde, la
    // conversion recopierait cette anomalie dans la nouvelle facture. Placé APRÈS
    // l'authentification et AVANT la transaction / toute écriture.
    const [quoteCheck] = await db
      .select({ patientId: quotes.patientId })
      .from(quotes)
      .where(and(eq(quotes.id, quoteId), eq(quotes.clinicId, clinicId)))
      .limit(1);

    if (!quoteCheck) throw new Error("Devis introuvable");
    await requireOwnedPatient(clinicId, quoteCheck.patientId);

    const invoiceId = await db.transaction(async (tx) => {
      // Z-22 : lecture VERROUILLÉE du devis. Une simple lecture laissait un
      // check-then-act : deux transactions concurrentes lisaient toutes les deux
      // `convertedInvoiceId = null` et facturaient chacune le devis. `FOR UPDATE`
      // sérialise les concurrents sur la ligne du devis.
      const [quote] = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, quoteId), eq(quotes.clinicId, clinicId)))
        .limit(1)
        .for("update");

      if (!quote) throw new Error("Devis introuvable");
      if (quote.convertedInvoiceId) throw new Error("Devis déjà facturé");
      if (quote.status !== "accepted") {
        throw new Error("Seul un devis accepté peut être facturé");
      }

      const items = await tx
        .select()
        .from(quoteItems)
        .where(eq(quoteItems.quoteId, quoteId));

      // Ensure sequence row exists, then atomically increment it.
      await tx
        .insert(documentSequences)
        .values({ clinicId, type: "invoice", lastNumber: 0 })
        .onConflictDoNothing();

      const [seq] = await tx
        .update(documentSequences)
        .set({ lastNumber: sql`last_number + 1` })
        .where(and(eq(documentSequences.clinicId, clinicId), eq(documentSequences.type, "invoice")))
        .returning();

      const nextNumber = seq?.lastNumber ?? 1;
      const number = `FAC-${new Date().getFullYear()}-${String(nextNumber).padStart(5, "0")}`;

      // Recompute totals from stored items (server-side authority).
      const totals = docTotals(
        items.map((item) => ({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate ?? 0,
          discount: item.discount ?? 0,
        })),
      );

      const [invoice] = await tx
        .insert(invoices)
        .values({
          clinicId,
          patientId: quote.patientId,
          number,
          date: new Date(),
          status: "draft",
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          discountTotal: totals.discountTotal,
          total: totals.total,
          notes: quote.notes ? `${quote.notes}\n— Devis ${quote.number}` : `Devis ${quote.number}`,
        })
        .returning();

      if (!invoice) throw new Error("Erreur lors de la création de la facture");

      if (items.length > 0) {
        await tx.insert(invoiceItems).values(
          items.map((item) => ({
            invoiceId: invoice.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRate: item.taxRate,
            discount: item.discount,
            total: lineTotal({
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              taxRate: item.taxRate ?? 0,
              discount: item.discount ?? 0,
            }),
          })),
        );
      }

      // Z-22 : « claim » conditionnel de la conversion. Sans
      // `AND converted_invoice_id IS NULL`, la seconde transaction concurrente
      // écrasait le lien (et sa propre facture restait engagée). Avec la
      // condition, Postgres réévalue le WHERE contre la version engagée de la
      // ligne : le second UPDATE affecte 0 ligne → `!claimed` → throw →
      // rollback de la facture, des lignes et de la séquence. Le décompte de
      // lignes (`RETURNING`) est donc le garde-fou qui annule la 2e conversion.
      const [claimed] = await tx
        .update(quotes)
        .set({ convertedInvoiceId: invoice.id })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.clinicId, clinicId),
            isNull(quotes.convertedInvoiceId),
          ),
        )
        .returning({ id: quotes.id });

      if (!claimed) throw new Error("Devis déjà facturé");

      return invoice.id;
    });

    await logAction({
      clinicId,
      action: "create",
      entityType: "invoice",
      entityId: invoiceId,
      after: { fromQuoteId: quoteId, actorUserId: user?.id ?? null },
    });
    await logAction({
      clinicId,
      action: "update",
      entityType: "quote",
      entityId: quoteId,
      after: { convertedInvoiceId: invoiceId },
    });

    revalidatePath(`/billing/quotes/${quoteId}`);
    revalidatePath("/billing/quotes");
    revalidatePath("/billing/invoices");

    return { success: true, invoiceId } as { success: boolean; invoiceId: string };
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: e instanceof Error ? e.message : "Erreur lors de la conversion du devis" };
  }
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
): Promise<{ error?: Record<string, string[]> }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    return { error: { general: ["Seuls la réception et le propriétaire peuvent gérer les factures"] } };
  }

  const validated = invoiceSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Garde d'appartenance : `patientId` provient du formulaire. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé. Placé APRÈS l'authentification
  // et AVANT toute écriture (incrémentation de séquence + INSERT de la facture).
  try {
    await requireOwnedPatient(clinicId, data.patientId);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique, inexistant ou archivé) :
    // remontée telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la création de la facture"] } };
  }

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

  const itemsParsed = parseLineItems(formData.get("items"));
  if (!itemsParsed.ok) {
    return { error: { items: ["Lignes de facture invalides : vérifiez descriptions, quantités et prix"] } };
  }
  const items = itemsParsed.items;

  const totals = docTotals(items);

  // Z-19 : la facture, ses lignes et l'audit sont écrits dans UNE transaction.
  // Sans elle, un échec du second INSERT survenait APRÈS
  // l'engagement de la facture : le `catch` renvoyait « Erreur lors de la
  // création » alors que la facture existait déjà → facture orpheline sans
  // lignes, ou double facturation après relance. Même pattern que
  // `convertQuoteToInvoice` et `closeSession` (`db.transaction` + `tx.insert`).
  try {
    await db.transaction(async (tx) => {
      const [invoice] = await tx.insert(invoices).values({
        clinicId,
        patientId: data.patientId,
        number,
        date: new Date(data.date),
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        status: "draft",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        discountTotal: totals.discountTotal,
        total: totals.total,
        notes: data.notes || null,
      }).returning();

      if (invoice && items.length > 0) {
        await tx.insert(invoiceItems).values(
          items.map((item) => ({
            invoiceId: invoice.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRate: item.taxRate,
            discount: item.discount,
            total: lineTotal(item),
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
          ...totals,
          notes: data.notes || null,
          itemCount: items.length,
        },
      });
    });

    revalidatePath("/billing/invoices");
    redirect("/billing/invoices");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création de la facture"] } };
  }
}

/**
 * Open (payable) invoices of one patient, with the amount still due.
 * Used by the payment page picker (/billing/payments/new).
 */
export async function getUnpaidInvoicesForPatient(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        total: invoices.total,
        status: invoices.status,
        paidAmount:
          sql<number>`COALESCE((SELECT SUM(p.amount) FROM payment p WHERE p.invoice_id = ${invoices.id}), 0)::float8`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.clinicId, clinicId),
          eq(invoices.patientId, patientId),
          inArray(invoices.status, ["draft", "sent", "partially_paid", "overdue"]),
        ),
      )
      .orderBy(desc(invoices.date));
  } catch {
    return [];
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

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    return { error: "Action non autorisée sur les factures" };
  }

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

  if (!(await hasAbility(clinicId, "billing:manage"))) {
    return { error: { general: ["Seuls la réception et le propriétaire peuvent encaisser des paiements"] } };
  }

  // Garde d'appartenance : `patientId` est un ARGUMENT de la Server Action, donc
  // directement contrôlable par le client. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé. Placé APRÈS l'authentification
  // et AVANT toute écriture (INSERT du paiement).
  //
  // ⚠️ Clé `amount` et NON `general` : `payment-form.tsx` ne rend que les clés
  // `amount` / `method` / `date` (et ignore explicitement `general`) — un message
  // sous `general` y serait invisible. À réaligner sur `general` dès que le
  // formulaire affichera une erreur générale.
  try {
    // ⚠️ `requirePatientOwnership` et NON `requireOwnedPatient` : encaisser est la
    // liquidation d'une dette EXISTANTE, pas une nouvelle activité. Le débiteur
    // archivé reste débiteur — un statut d'affichage ne doit jamais geler un fait
    // comptable (scénario fréquent : patient archivé qui solde son reste).
    // L'invariant de sécurité est la PROPRIÉTÉ (clinicId), pas l'archivage.
    // Le `invoiceId` est par ailleurs déjà clinic-scopé plus bas.
    await requirePatientOwnership(clinicId, patientId);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique ou inexistant) : remontée
    // telle quelle, distincte de l'erreur technique générique. Le message est
    // identique dans les deux cas — pas d'oracle d'énumération.
    if (e instanceof Error && e.message === "Patient introuvable") {
      return { error: { amount: ["Patient introuvable"] } };
    }
    return { error: { amount: ["Erreur lors de l'enregistrement du paiement"] } };
  }

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
    if (invoiceId) {
      const [existing] = await db
        .select({ id: invoices.id, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.clinicId, clinicId)))
        .limit(1);

      if (!existing) {
        return { error: { general: ["Facture introuvable pour cette clinique"] } };
      }
      if (existing.status === "cancelled") {
        return { error: { general: ["Impossible d'enregistrer un paiement sur une facture annulée"] } };
      }
    }

    // Z-23 : l'INSERT du paiement, la relecture de la facture et l'écriture du
    // statut sont réunis dans UNE transaction. La facture est relue avec
    // `SELECT … FOR UPDATE` AVANT l'insertion du paiement : le verrou de ligne
    // tient jusqu'au COMMIT et sérialise donc entièrement les encaissements
    // concurrents sur une même facture (aucun encaissement ne peut s'intercaler
    // entre la relecture et l'UPDATE). Chaque transaction n'insère son paiement
    // qu'après avoir obtenu le verrou : la dernière à le tenir revoit dans son
    // SUM tous les paiements engagés par ses prédécesseurs → statut recalculé
    // sur une base complète, plus de lost update (deux encaissements
    // simultanés complétant le total laissant la facture en `partially_paid`).
    await db.transaction(async (tx) => {
      const lockedInvoice = invoiceId
        ? ((await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.id, invoiceId), eq(invoices.clinicId, clinicId)))
            .limit(1)
            .for("update"))[0] ?? null)
        : null;

      if (invoiceId) {
        // Re-vérification des gardes DANS la transaction (la lecture externe
        // ci-dessus n'est qu'un pré-calcul pour un message d'erreur plus tôt) :
        // la facture peut être annulée/supprimée entre les deux, et surtout elle
        // peut être verrouillée par une autre transaction.
        if (!lockedInvoice) {
          throw new Error("Facture introuvable pour cette clinique");
        }
        if (lockedInvoice.status === "cancelled") {
          throw new Error("Impossible d'enregistrer un paiement sur une facture annulée");
        }
      }

      const [payment] = await tx.insert(payments).values({
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

      if (lockedInvoice) {
        // Somme des paiements relue SOUS verrou, après l'INSERT du paiement
        // courant : elle inclut donc ce paiement et tout paiement concurrent
        // déjà committé.
        const invoicePayments = await tx
          .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::float8` })
          .from(payments)
          .where(eq(payments.invoiceId, lockedInvoice.id));

        const paidAmount = invoicePayments[0]?.total || 0;
        const newStatus = recalcInvoiceStatus(
          lockedInvoice.status,
          lockedInvoice.total,
          paidAmount,
        );

        await tx
          .update(invoices)
          .set({ status: newStatus })
          .where(eq(invoices.id, lockedInvoice.id));

        if (newStatus === "paid" && lockedInvoice.sessionId) {
          await tx
            .update(clinicalSessions)
            .set({ status: "paid" })
            .where(eq(clinicalSessions.id, lockedInvoice.sessionId));
          revalidatePath(`/patients/${lockedInvoice.patientId}/session/${lockedInvoice.sessionId}`);
        }

        if (lockedInvoice.sessionId) {
          sessionRedirectPath = `/patients/${lockedInvoice.patientId}/session/${lockedInvoice.sessionId}`;
        }
      }
    });

    if (invoiceId) {
      revalidatePath(`/billing/invoices/${invoiceId}`);
    }

    revalidatePath("/billing/invoices");
    redirect(sessionRedirectPath ?? "/billing/invoices");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de l'enregistrement du paiement"] } };
  }
}
