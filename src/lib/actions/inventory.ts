"use server";

import { db } from "@/lib/db/db";
import { stockItems, stockTransactions, stockAlerts } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, getCurrentUser, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, asc, desc, lt, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

const stockItemSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  category: z.string().optional().or(z.literal("")),
  description: z.string().optional().or(z.literal("")),
  currentQty: z.coerce.number().int().min(0, "Quantité ne peut pas être négative").optional().or(z.literal("")),
  minQty: z.coerce.number().int().optional().or(z.literal("")),
  unit: z.string().optional().or(z.literal("")),
  supplierId: z.string().optional().or(z.literal("")),
  purchasePrice: z.coerce.number().min(0).optional().or(z.literal("")),
  sellingPrice: z.coerce.number().min(0).optional().or(z.literal("")),
});

const stockTransactionSchema = z.object({
  itemId: z.string().min(1, "Article requis"),
  type: z.enum(["in", "out", "adjustment"], { message: "Type invalide" }),
  qty: z.coerce.number().int().positive("Quantité doit être positive"),
  unitPrice: z.coerce.number().min(0).optional().or(z.literal("")),
  reference: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

// Résultat de la mutation atomique du stock (Z-60).
type StockMutationOutcome =
  | { ok: true; newQty: number; txId: string }
  | { ok: false; failure: "insufficient" | "missing" };

export async function getStockItems() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.clinicId, clinicId))
      .orderBy(asc(stockItems.name));
  } catch (err) {
    // Z-71 — une panne transitoire n'est PLUS convertie en « 0 article » :
    // l'erreur est journalisée côté serveur puis REMONTÉE. Le contrat de
    // retour (`StockItem[]`) est intact — il ne porte aucun type d'erreur —
    // c'est le canal d'exception qui distingue « base indisponible » de
    // `[]` (= réellement aucun article). Même remède que Z-32 sur `getInvoice`.
    console.error("[getStockItems] lecture du stock impossible", { clinicId, err });
    throw err;
  }
}

export async function getStockItem(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [item] = await db
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.id, id), eq(stockItems.clinicId, clinicId)))
      .limit(1);

    if (!item) {
      return null;
    }

    const transactions = await db
      .select()
      .from(stockTransactions)
      .where(eq(stockTransactions.itemId, id))
      .orderBy(desc(stockTransactions.createdAt));

    return { ...item, transactions };
  } catch (err) {
    // Z-71 — `null` reste EXCLUSIVEMENT « ressource absente » : le contrat
    // `T | null` ne peut pas porter de type d'erreur sans changer de signature,
    // l'erreur technique est donc journalisée puis propagée (au lieu d'être
    // avalée en un `null` identique à un article inexistant).
    console.error("[getStockItem] lecture de l'article impossible", { id, clinicId, err });
    throw err;
  }
}

export async function createStockItem(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = stockItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [created] = await db.insert(stockItems).values({
      clinicId,
      name: data.name,
      category: data.category || null,
      description: data.description || null,
      currentQty: data.currentQty ? Number(data.currentQty) : 0,
      minQty: data.minQty ? Number(data.minQty) : 0,
      unit: data.unit || null,
      supplierId: data.supplierId || null,
      purchasePrice: data.purchasePrice ? Number(data.purchasePrice) : null,
      sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : null,
    }).returning({ id: stockItems.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "inventory_item",
      entityId: created.id,
      after: {
        name: data.name,
        category: data.category || null,
        currentQty: data.currentQty ? Number(data.currentQty) : 0,
        minQty: data.minQty ? Number(data.minQty) : 0,
        unit: data.unit || null,
      },
    });

    revalidatePath("/stock");
    redirect("/stock");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création de l'article"] } };
  }
}

export async function updateStockItem(
  itemId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = stockItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Z-61 : un champ « quantité » absent (ou vide) du FormData ne doit pas
  // remettre le stock à 0 — on ne touche alors pas à `currentQty`.
  const rawCurrentQty = formData.get("currentQty");
  const hasCurrentQty = typeof rawCurrentQty === "string" && rawCurrentQty.trim() !== "";
  const nextCurrentQty =
    hasCurrentQty && typeof data.currentQty === "number"
      ? Math.max(0, data.currentQty)
      : undefined;

  try {
    const [current] = await db
      .select({
        name: stockItems.name,
        category: stockItems.category,
        description: stockItems.description,
        currentQty: stockItems.currentQty,
        minQty: stockItems.minQty,
        unit: stockItems.unit,
        supplierId: stockItems.supplierId,
        purchasePrice: stockItems.purchasePrice,
        sellingPrice: stockItems.sellingPrice,
      })
      .from(stockItems)
      .where(and(eq(stockItems.id, itemId), eq(stockItems.clinicId, clinicId)))
      .limit(1);

    // Z-72 — sans cette garde, l'UPDATE « réussissait » sur 0 ligne (id
    // inexistant ou déjà supprimé) et l'action redirigeait vers un succès
    // sans jamais rien écrire ni auditer.
    if (!current) {
      return { error: { general: ["Article introuvable"] } };
    }

    // Z-72 — décompte des lignes réellement affectées : l'article peut avoir
    // été supprimé entre la lecture ci-dessus et cet UPDATE (fenêtre de
    // course) ; 0 ligne → refus explicite au lieu d'un succès mensonger.
    const updatedRows = await db
      .update(stockItems)
      .set({
        name: data.name,
        category: data.category || null,
        description: data.description || null,
        ...(nextCurrentQty !== undefined ? { currentQty: nextCurrentQty } : {}),
        minQty: data.minQty ? Number(data.minQty) : 0,
        unit: data.unit || null,
        supplierId: data.supplierId || null,
        purchasePrice: data.purchasePrice ? Number(data.purchasePrice) : null,
        sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : null,
      })
      .where(and(eq(stockItems.id, itemId), eq(stockItems.clinicId, clinicId)))
      .returning({ id: stockItems.id });

    if (updatedRows.length === 0) {
      return { error: { general: ["Article introuvable ou déjà supprimé"] } };
    }

    await logAction({
      clinicId,
      action: "update",
      entityType: "inventory_item",
      entityId: itemId,
      before: current ? {
        name: current.name,
        category: current.category ?? null,
        description: current.description ?? null,
        currentQty: current.currentQty,
        minQty: current.minQty,
        unit: current.unit ?? null,
      } : undefined,
      after: {
        name: data.name,
        category: data.category || null,
        currentQty: nextCurrentQty ?? current?.currentQty ?? 0,
        minQty: data.minQty ? Number(data.minQty) : 0,
        unit: data.unit || null,
      },
    });

    revalidatePath("/stock");
    revalidatePath(`/stock/${itemId}`);
    redirect("/stock");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la mise à jour de l'article"] } };
  }
}

export async function deleteStockItem(
  itemId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  void prevState;
  void formData;
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // Check if item has transactions
    const [item] = await db
      .select({ id: stockItems.id, name: stockItems.name })
      .from(stockItems)
      .where(and(eq(stockItems.id, itemId), eq(stockItems.clinicId, clinicId)))
      .limit(1);

    if (!item) {
      return { error: { general: ["Article introuvable"] } };
    }

    const transactions = await db
      .select({ id: stockTransactions.id })
      .from(stockTransactions)
      .where(eq(stockTransactions.itemId, itemId))
      .limit(1);

    if (transactions.length > 0) {
      return { error: { general: ["Impossible de supprimer un article avec des transactions associées"] } };
    }

    await db
      .delete(stockItems)
      .where(and(eq(stockItems.id, itemId), eq(stockItems.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "inventory_item",
      entityId: itemId,
      before: { name: item.name },
    });

    revalidatePath("/stock");
    redirect("/stock");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la suppression de l'article"] } };
  }
}

export async function createStockTransaction(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = stockTransactionSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const qty = data.qty;
  const user = await getCurrentUser();

  try {
    const [item] = await db
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.id, data.itemId), eq(stockItems.clinicId, clinicId)))
      .limit(1);

    if (!item) {
      return { error: { itemId: ["Article introuvable"] } };
    }

    const qtyChange = data.type === "in" ? qty : data.type === "out" ? -qty : qty;
    const isOut = data.type === "out";

    // Z-60 : mutation atomique. L'incrémentation est calculée en SQL (aucun
    // read-then-write en JS), une sortie n'est appliquée que si la ligne
    // possède encore `current_qty >= qty` (nombre de lignes vérifié via
    // RETURNING), et le mouvement est inséré dans la même transaction que la
    // mise à jour du stock — le stock et le registre restent alignés.
    const outcome: StockMutationOutcome = await db.transaction(
      async (tx): Promise<StockMutationOutcome> => {
        const guard = isOut ? [gte(stockItems.currentQty, qty)] : [];

        const updatedRows = await tx
          .update(stockItems)
          .set({
            currentQty: isOut
              ? sql`${stockItems.currentQty} - ${qty}`
              : sql`${stockItems.currentQty} + ${qty}`,
          })
          .where(
            and(
              eq(stockItems.id, data.itemId),
              eq(stockItems.clinicId, clinicId),
              ...guard,
            ),
          )
          .returning({ currentQty: stockItems.currentQty });

        const [updated] = updatedRows;
        if (!updated) {
          return { ok: false, failure: isOut ? "insufficient" : "missing" };
        }

        const [createdTx] = await tx
          .insert(stockTransactions)
          .values({
            itemId: data.itemId,
            type: data.type,
            qty,
            unitPrice: data.unitPrice ? Number(data.unitPrice) : null,
            reference: data.reference || null,
            notes: data.notes || null,
            createdBy: user?.id ?? null,
          })
          .returning({ id: stockTransactions.id });

        return { ok: true, newQty: updated.currentQty, txId: createdTx.id };
      },
    );

    if (!outcome.ok) {
      return outcome.failure === "insufficient"
        ? { error: { qty: ["Quantité en stock insuffisante"] } }
        : { error: { itemId: ["Article introuvable"] } };
    }

    const newQty = outcome.newQty;
    // Valeur exacte : `newQty` provient d'une incrémentation SQL atomique.
    const previousQty = newQty - qtyChange;

    await logAction({
      clinicId,
      action: "create",
      entityType: "stock_transaction",
      entityId: outcome.txId,
      after: {
        itemId: data.itemId,
        type: data.type,
        qty,
        unitPrice: data.unitPrice ? Number(data.unitPrice) : null,
        previousQty,
        newQty,
      },
    });

    if (newQty < item.minQty) {
      const [existingAlert] = await db
        .select({ id: stockAlerts.id })
        .from(stockAlerts)
        .where(
          and(
            eq(stockAlerts.itemId, data.itemId),
            eq(stockAlerts.status, "active"),
          ),
        )
        .limit(1);

      if (!existingAlert) {
        // Z-62 : l'index unique partiel (item_id) WHERE status = 'active'
        // referme la course check-then-insert ; le conflit est ignoré.
        await db
          .insert(stockAlerts)
          .values({
            clinicId,
            itemId: data.itemId,
            threshold: item.minQty,
          })
          .onConflictDoNothing();
      }
    } else {
      // Z-62 : réapprovisionnement au-dessus du seuil — l'alerte active est
      // résolue, sinon aucune nouvelle alerte ne serait plus jamais générée.
      await db
        .update(stockAlerts)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(
            eq(stockAlerts.clinicId, clinicId),
            eq(stockAlerts.itemId, data.itemId),
            eq(stockAlerts.status, "active"),
          ),
        );
    }

    revalidatePath("/stock");
    revalidatePath(`/stock/${data.itemId}`);
    redirect("/stock");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la transaction de stock"] } };
  }
}

export async function getLowStockItems() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(stockItems)
      .where(
        and(
          eq(stockItems.clinicId, clinicId),
          lt(stockItems.currentQty, stockItems.minQty),
        ),
      )
      .orderBy(asc(stockItems.name));
  } catch (err) {
    // Z-71 — « 0 article en rupture » et « lecture impossible » ne doivent pas
    // avoir le même affichage (décision d'achat sur un faux chiffre) :
    // journalisation puis remontée, contrat `StockItem[]` inchangé.
    console.error("[getLowStockItems] lecture des ruptures impossible", { clinicId, err });
    throw err;
  }
}
