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
import { requireAuth, requireClinicAccessOrThrow, hasAbility } from "@/lib/auth-utils";
import { eq, ne, and, asc, desc, sql, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";
import {
  isSessionStatusTransitionAllowed,
} from "@/lib/session-rules";
import { docTotals, lineTotal } from "@/lib/billing-math";
import { createNumberingDbRepo } from "@/lib/sync/numbering";
import {
  allocateDocumentNumber,
  allocateNumberErrorMessage,
  createDeviceAllocateDeps,
  isBlockNumberingMode,
  type AllocateDeps,
} from "@/lib/sync/allocate-number";

type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Tâche 6.1c — mode blocs (D-4) : deps de l'allocateur de numéros sur la base
 * partagée. `DEVICE_ID` absent (Vercel / dev classique) → la chimie historique
 * `last_number + 1` de `closeSession` reste strictement inchangée.
 */
function blockNumberingDeps(): AllocateDeps {
  return createDeviceAllocateDeps(createNumberingDbRepo(db));
}

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
    with: { patient: true, prescription: true },
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

  // BLOQUANT 1 (ii) — la séance renvoie sa facture ACTIVE la plus récente ;
  // une facture `cancelled` vaut `null` (« la séance n'a pas de facture
  // active »). C'est cette sémantique qui fait réapparaître
  // `CloseSessionForm` (`status === "in_progress" && !invoice`) après une
  // annulation, donc qui rend la RE-CLÔTURE possible.
  //
  // La relation `invoice` (sans filtre de statut, sans `ORDER BY`) ne convient
  // plus : depuis l'annulation puis la re-clôture, une séance peut porter
  // DEUX factures (l'annulée + la re-facturée, `UNIQUE (invoice.session_id)`
  // partiel absent — cf. Z-21), et son `LIMIT 1` pouvait tomber sur la facture
  // ANNULÉE → après filtrage, `invoice` aurait été `null` sur une séance
  // pourtant facturée (bouton « Clore la séance » affiché à tort ET boutons
  // « Marquer facturée »/« Marquer payée » masqués). D'où le filtre
  // `ne(cancelled)` + `ORDER BY createdAt DESC` : cible non annulée et
  // déterministe, exactement comme dans `updateSessionStatus`.
  const invoice =
    (await db.query.invoices.findFirst({
      where: and(
        eq(invoices.sessionId, sessionId),
        eq(invoices.clinicId, clinicId),
        ne(invoices.status, "cancelled"),
      ),
      orderBy: (fields, { desc }) => [desc(fields.createdAt)],
      with: { items: true, payments: true },
    })) ?? null;

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

/**
 * Recalcule le total de la séance **en incluant la TVA**, pour qu'il soit
 * identique au montant facturé (le `SUM` SQL précédent ignorait `tax_rate` :
 * un acte à 1000 DZD à 19 % affichait 1000 en séance et 1190 sur la facture).
 *
 * ⚠️ NON EXPORTÉE : ce module porte `"use server"`, donc toute fonction
 * exportée en devient une Server Action invocable publiquement. Les 3 call
 * sites sont internes au fichier.
 */
async function recalculateSessionTotal(
  sessionId: string,
  tx?: DbOrTx,
): Promise<number> {
  const client = tx ?? db;

  const items = await client
    .select({
      quantity: clinicalSessionItems.quantity,
      fee: clinicalSessionItems.fee,
      taxRate: clinicalSessionItems.taxRate,
      discount: clinicalSessionItems.discount,
    })
    .from(clinicalSessionItems)
    .where(eq(clinicalSessionItems.sessionId, sessionId));

  // Référence métier : `docTotals` (déjà utilisée par `closeSession` pour la
  // facture et par les devis) — la TVA est calculée en TypeScript dans
  // billing-math.ts, donc le total séance est recalculé ici en TS plutôt qu'en
  // SQL. La séance doit toujours afficher au patient le montant qui sera
  // facturé (base + TVA − remise).
  const total = docTotals(
    items.map((item) => ({
      quantity: item.quantity,
      unitPrice: item.fee,
      taxRate: item.taxRate ?? 0,
      discount: item.discount ?? 0,
    })),
  ).total;

  await client
    .update(clinicalSessions)
    .set({ totalAmount: total })
    .where(eq(clinicalSessions.id, sessionId));

  return total;
}

const clinicalSessionItemSchema = z
  .object({
    toothNumber: z.coerce.number().int().optional(),
    surface: z.string().optional().default("").catch(""),
    procedureCode: z.string().optional().default("").catch(""),
    description: z.string().min(1, "Description requise"),
    fee: z.coerce.number().min(0),
    quantity: z.coerce.number().int().positive().default(1),
    discount: z.coerce.number().min(0).default(0),
    taxRate: z.coerce.number().int().default(0),
  })
  // Z-34 — même garde que `lineItemSchema` côté facturation : sans elle, une
  // remise supérieure au montant de la ligne (`fee × quantity − discount < 0`)
  // était acceptée puis recalculée dans `clinical_sessions.total_amount` comme
  // un total négatif.
  .refine((item) => item.fee * item.quantity - item.discount >= 0, {
    message: "La remise dépasse le montant de la ligne",
    path: ["discount"],
  });

/**
 * Z-28 — verrou + garde « séance déjà facturée », à appeler EN PREMIER dans
 * chaque transaction qui modifie les actes d'une séance (ajout / modification /
 * suppression), avant toute écriture.
 *
 * Statuts réels de `clinical_session` (enum PG `clinical_session_status`) :
 * `pending`, `in_progress`, `completed`, `invoiced`, `paid`. Le seul statut
 * qui garantisse l'absence de facture est `in_progress` (et `pending`,
 * état initial jamais facturé) — `closeSession` laisse la séance `completed`
 * APRÈS avoir créé la facture, donc `completed` ne suffit pas : on teste
 * aussi l'existence d'une facture liée (`invoice.session_id`), qui est
 * l'indicateur exact de « déjà facturée ». Renvoie `null` si la séance est
 * modifiable, sinon le message d'erreur à afficher.
 *
 * Modifiable = statut non facturé ET aucune facture LIÉE active. Les factures
 * `cancelled` sont EXCLUES du garde : une facture annulée est un document
 * comptable neutralisé (statut terminal, Z-31) qui ne garantit plus rien. Sans
 * cette exclusion, une séance dont l'utilisateur a annulé la facture Brouillon
 * pour corriger des actes était gelée à jamais (« Séance déjà facturée » alors
 * que la facture est annulée) et AUCUN chemin de re-facturation n'existait.
 * La séance redevient alors éditable ; une nouvelle clôture (`closeSession`)
 * créera une NOUVELLE facture avec un nouveau numéro (`document_sequence`).
 *
 * Le `SELECT … FOR UPDATE` sérialise la mutation d'actes avec `closeSession`
 * (dont le `UPDATE … WHERE status = 'in_progress'` verrouille la même ligne) :
 * une clôture concurrente ne peut pas s'intercaler entre la garde et
 * l'écriture. Verrou ajouté SANS réordonner les verrous existants (les
 * transactions d'actes n'en contenaient aucun auparavant).
 */
async function lockSessionForItemEdit(
  tx: DbOrTx,
  clinicId: string,
  sessionId: string,
): Promise<string | null> {
  const [session] = await tx
    .select({ id: clinicalSessions.id, status: clinicalSessions.status })
    .from(clinicalSessions)
    .where(
      and(
        eq(clinicalSessions.id, sessionId),
        eq(clinicalSessions.clinicId, clinicId),
      ),
    )
    .limit(1)
    .for("update");

  if (!session) return "Séance introuvable";

  if (session.status === "invoiced" || session.status === "paid") {
    return "Séance déjà facturée : les actes ne peuvent plus être modifiés";
  }

  const [invoice] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.sessionId, sessionId),
        eq(invoices.clinicId, clinicId),
        // BLOQUANT 2 : une facture annulée ne gèle plus les actes.
        ne(invoices.status, "cancelled"),
      ),
    )
    .limit(1);

  if (invoice) {
    return "Séance déjà facturée : les actes ne peuvent plus être modifiés";
  }

  return null;
}

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

    const result = await db.transaction(
      async (tx): Promise<{ blocked: string; createdId?: null } | { blocked: null; createdId: string | null }> => {
        // Z-28 : garde « séance déjà facturée » posée AVANT toute écriture.
        const blocked = await lockSessionForItemEdit(tx, clinicId, sessionId);
        if (blocked) return { blocked, createdId: null };

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

        await recalculateSessionTotal(sessionId, tx);

        return { blocked: null, createdId: created?.id ?? null };
      },
    );

    if (result.blocked) {
      return { error: { general: [result.blocked] } };
    }

    if (result.createdId) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "clinical_session_item",
        entityId: result.createdId,
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

    const result = await db.transaction(
      async (tx): Promise<{ blocked: string } | { blocked: null }> => {
        // Z-28 : garde « séance déjà facturée » posée AVANT toute écriture.
        const blocked = await lockSessionForItemEdit(tx, clinicId, item.sessionId);
        if (blocked) return { blocked };

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

        return { blocked: null };
      },
    );

    if (result.blocked) {
      return { error: { general: [result.blocked] } };
    }

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

    const result = await db.transaction(
      async (tx): Promise<{ blocked: string } | { blocked: null }> => {
        // Z-28 : garde « séance déjà facturée » posée AVANT toute écriture.
        const blocked = await lockSessionForItemEdit(tx, clinicId, item.sessionId);
        if (blocked) return { blocked };

        await tx
          .delete(clinicalSessionItems)
          .where(eq(clinicalSessionItems.id, itemId));

        await recalculateSessionTotal(item.sessionId, tx);

        return { blocked: null };
      },
    );

    if (result.blocked) {
      return { error: result.blocked };
    }

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

  if (!(await hasAbility(clinicId, "billing:session_close"))) {
    return { error: "Vous n'êtes pas autorisé à clôturer une séance" };
  }

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

    const totals = docTotals(
      items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.fee,
        taxRate: item.taxRate ?? 0,
        discount: item.discount ?? 0,
      })),
    );

    const now = new Date();
    const year = now.getFullYear();

    // Z-21 : la garde `status !== "in_progress"` ci-dessus est lue HORS
    // transaction — deux clôtures concurrentes passent toutes les deux la garde
    // JS. Le verrou retenu : la condition `status = 'in_progress'` est REJOUÉE
    // dans le `WHERE` de l'UPDATE, et le décompte de lignes affectées
    // (`RETURNING`) décide qui poursuit AVANT toute écriture de facture,
    // de séquence ou d'audit. Le second appel sort immédiatement du callback :
    // sa transaction ne contient alors AUCUNE écriture (l'UPDATE a affecté 0
    // ligne), donc rien à annuler → une seule facture par séance, y compris
    // sous concurrence. (Le verrou DB définitif serait
    // `UNIQUE (invoice.session_id)` — hors périmètre de cette tâche.)
    // Tâche 6.1c — mode blocs (D-4) : le numéro de facture est réservé AVANT
    // la transaction (aucun appel réseau sous verrou ; un refus sort ici, sans
    // rien écrire — y compris le verrou `status`). En cas de course perdue sur
    // ce verrou, il ne reste qu'un TROU dans la numérotation, jamais un
    // doublon. Mode web : l'incrément `last_number + 1` reste DANS la
    // transaction, inchangé.
    let reservedNumber: number | undefined;
    if (isBlockNumberingMode()) {
      const allocated = await allocateDocumentNumber(blockNumberingDeps(), {
        clinicId,
        type: "invoice",
      });
      if (!allocated.ok) {
        return { error: allocateNumberErrorMessage(allocated.reason) };
      }
      reservedNumber = allocated.number;
    }

    const closed = await db.transaction(async (tx): Promise<boolean> => {
      const [claimed] = await tx
        .update(clinicalSessions)
        .set({ status: "completed", completedAt: new Date() })
        .where(
          and(
            eq(clinicalSessions.id, sessionId),
            eq(clinicalSessions.clinicId, clinicId),
            eq(clinicalSessions.status, "in_progress"),
          ),
        )
        .returning({ id: clinicalSessions.id });

      if (!claimed) return false;

      let nextNumber: number;
      if (reservedNumber !== undefined) {
        // Mode blocs : numéro déjà réservé avant la transaction (D-4).
        nextNumber = reservedNumber;
      } else {
        // Ensure sequence row exists (ignore if already exists)
        // (mode web — chimie historique inchangée)
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

        nextNumber = seq?.lastNumber ?? 1;
      }
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
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          discountTotal: totals.discountTotal,
          total: totals.total,
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
            total: lineTotal({
              quantity: item.quantity,
              unitPrice: item.fee,
              taxRate: item.taxRate ?? 0,
              discount: item.discount ?? 0,
            }),
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
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            total: totals.total,
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

      return true;
    });

    if (!closed) {
      // Course perdue : une autre clôture a verrouillé la séance la première.
      return { error: "Séance déjà clôturée ou terminée" };
    }

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

  // Z-27 — contrôle de rôle (jusqu'ici absent : `requireAuth` +
  // `requireClinicAccessOrThrow` suffisaient, alors que cette action écrit
  // DIRECTEMENT `invoices.status`). Cohérent avec les actions voisines :
  //  • les cibles qui touchent une facture (`invoiced` → facture `sent`,
  //    `paid` → facture `paid`) exigent la même habilité que
  //    `updateInvoiceStatus` : `billing:manage` ;
  //  • la réouverture de séance (`in_progress`, BLOQUANT 2) exige la même
  //    habilité que `closeSession` : `billing:session_close` (c'est la branche
  //    `!touchesInvoice` ci-dessous).
  const touchesInvoice = status === "invoiced" || status === "paid";
  if (touchesInvoice && !(await hasAbility(clinicId, "billing:manage"))) {
    return { error: "Action non autorisée sur les factures" };
  }
  if (!touchesInvoice && !(await hasAbility(clinicId, "billing:session_close"))) {
    return { error: "Vous n'êtes pas autorisé à clôturer une séance" };
  }

  // MINEUR + BLOQUANT 2 — domaine RUNTIME de la cible. `status` est un
  // argument de Server Action : la validité TypeScript n'est PAS vérifiée à
  // l'exécution, et aucun Zod ne valide cette action. On le recopie dans un
  // `string` : la signature publique de l'action est FIGÉE (union
  // `"completed" | "invoiced" | "paid"`), or `in_progress` — accepté plus bas
  // sous garde corrélée — n'en fait pas partie, et comparer littéralement la
  // union rétrécie `status` à `"in_progress"` ne compilerait pas.
  //  • `completed` est RETIRÉ du domaine : aucun appelant UI ne l'utilise
  //    (`session-invoice.tsx` ne lie que `invoiced`/`paid`), et avec l'arête
  //    `in_progress → completed`, un détenteur de `billing:session_close`
  //    aurait pu marquer une séance `completed` SANS facture → état non
  //    récupérable ;
  //  • `invoiced | paid` : cibles « facturation » (habilité `billing:manage`
  //    exigée ci-dessus) ;
  //  • `in_progress` : réouverture, admise UNIQUEMENT sous la garde corrélée
  //    posée dans la transaction (toutes les factures liées sont `cancelled`).
  //    Sans cette garde, un appelant régresserait une séance DÉJÀ facturée
  //    vers `in_progress` puis relancerait `closeSession` → une SECONDE
  //    facture pour la même séance (pas de contrainte
  //    `UNIQUE (invoice.session_id)` encore, cf. Z-21).
  const target: string = status;
  const isReopen = target === "in_progress";
  if (!isReopen && target !== "invoiced" && target !== "paid") {
    return { error: "Statut de séance invalide" };
  }

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

    const txResult = await db.transaction(
      async (tx): Promise<{ blocked: string | null }> => {
        // BLOQUANT 1 (i) + BLOQUANT 2 — LECTURE UNIQUE de la facture cible,
        // exécutée AVANT toute écriture et faisant foi pour LES DEUX gardes
        // (ciblage `invoiced`/`paid` ET garde corrélée de réouverture).
        // Elle est SANS `FOR UPDATE` : elle n'acquiert AUCUN verrou de ligne,
        // donc aucun verrou n'est réordonné par rapport à l'écriture initiale
        // (le premier verrou acquis par cette transaction reste l'`UPDATE
        // clinical_sessions`) — ordre des verrous Z-19 → Z-26 inchangé.
        //
        // `ne(cancelled)` + `ORDER BY createdAt DESC` : depuis l'annulation
        // puis la re-clôture, une séance peut légitimement porter plusieurs
        // factures (l'annulée + l'active). Ce `LIMIT 1` doit viser
        // DÉTERMINISTEMENT la facture NON ANNULÉE ; sans le filtre, il
        // retombait très probablement sur l'ancienne facture annulée et le
        // refus « Facture annulée » partait alors sur une facture ACTIVE →
        // « Marquer facturée » / « Marquer payée » refusés à tort.
        const [activeInvoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.sessionId, sessionId),
              eq(invoices.clinicId, clinicId),
              ne(invoices.status, "cancelled"),
            ),
          )
          .orderBy(desc(invoices.createdAt))
          .limit(1);

        if (isReopen) {
          // BLOQUANT 2 — garde CORRÉLÉE (remplace le refus catégorique de la
          // cible `in_progress`) : la réouverture n'est admise que si TOUTES
          // les factures liées de la séance sont `cancelled`, ce qui est
          // exactement l'absence de facture active constatée ci-dessus.
          // La justification anti-double-facture est conservée INTEGRALEMENT :
          // une séance dont la facture est ACTIVE n'est jamais régressée vers
          // `in_progress`, donc jamais re-clôturable en double.
          if (activeInvoice) {
            return {
              blocked:
                "Séance facturée : la réouverture n'est autorisée que si toutes ses factures liées sont annulées",
            };
          }
        } else if (!activeInvoice) {
          // BLOQUANT 1 (i) — refus UNIQUEMENT quand AUCUNE facture active
          // n'existe. `cancelled` est TERMINAL dans
          // `INVOICE_STATUS_TRANSITIONS` (Z-31) : sans facture cible, on ne
          // réécrit RIEN dans ce cas (sinon l'UPDATE de facture ci-dessous
          // RÉSSUSCITERAIT un document annulé en `sent`/`paid`).
          return {
            blocked:
              "Facture annulée : la séance ne peut plus être facturée ni marquée payée",
          };
        }

        // Aucune écriture tant que les gardes ci-dessus n'ont pas été franchies.
        await tx
          .update(clinicalSessions)
          .set({ status })
          .where(eq(clinicalSessions.id, sessionId));

        // Inatteignable pour `in_progress` (la garde corrélée ci-dessus
        // garantit `activeInvoice === null` dans cette branche).
        if (activeInvoice) {
          invoiceId = activeInvoice.id;
          await tx
            .update(invoices)
            .set({ status: target === "invoiced" ? "sent" : "paid" })
            .where(eq(invoices.id, activeInvoice.id));
        }

        return { blocked: null };
      },
    );

    if (txResult.blocked) {
      return { error: txResult.blocked };
    }

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
      // Z-59 — la suppression cible l'entrée LIÉE À CETTE SÉANCE, plus toutes les
      // entrées actives du patient (l'ancien filtre `clinicId + patientId +
      // status actif` détruisait aussi l'entrée d'un AUTRE parcours du même
      // patient : deux entrées actives ⇒ suppression en cascade des deux).
      //
      // Le lien disponible sans migration : `waiting_room_entry.appointment_id`.
      //  • séance rattachée à un RDV → l'entrée portant CE `appointment_id` ;
      //  • séance sans RDV (walk-in / démarrée depuis la fiche patient) →
      //    l'entrée walk-in (`appointment_id IS NULL`), seule entrée rattachable
      //    à une telle séance.
      // `clinicId + patientId + statut actif` restent en place (défense en
      // profondeur + index existant).
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
            ...(session.appointmentId
              ? [eq(waitingRoomEntries.appointmentId, session.appointmentId)]
              : [isNull(waitingRoomEntries.appointmentId)]),
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
