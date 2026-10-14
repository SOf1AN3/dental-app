import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { documentSequences } from "@/lib/db/schema";
import { SyncScopeError } from "@/lib/sync/central-store";
import {
  verifyDeviceToken,
  type DeviceTokenContext,
} from "@/lib/sync/central-auth";
import { documentSequenceTypeSchema } from "@/lib/sync/numbering";
import {
  computeBlockStart,
  findHighestIssuedNumber,
} from "@/lib/sync/block-floor";

/**
 * Tâche 6.1 — `POST /api/sync/blocks` : **réservation d'un bloc de numéros**
 * (décision client D-4). Tâche 6.1b : **renouvellement** d'un bloc épuisé +
 * **plancher anti-doublon**.
 *
 * Un compteur atomique (`document_sequence.last_number`) est inallocable
 * hors-ligne : deux postes créant une facture offline inventeraient le même
 * numéro. La route découpe donc **côté central** un intervalle exclusif
 * `[block_start … block_end]` pour UN poste, qui le consomme ensuite localement
 * sans réseau (`src/lib/sync/numbering.ts`). Bloc épuisé hors-ligne → le poste
 * refuse explicitement de créer le document : **jamais de numéro inventé**.
 *
 * Contrat (aligné sur `/api/sync/push` et `/api/sync/pull`) :
 *  - `Authorization: Bearer <jeton d'appareil>` — absent / malformé / inconnu /
 *    révoqué / expiré → **401** (échec fermé, message générique) ;
 *  - corps `{ clinicId, type, size?, cursor? }` validé par Zod → sinon **400**
 *    (`size` entier borné [1, 200], défaut 50 ; `type` limité aux types
 *    réellement numérotés : `invoice`, `quote`, `prosthesis:<année>` ;
 *    `cursor` entier ≥ 0 = `last_number` local du poste, preuve que le bloc
 *    détenu est épuisé) ;
 *  - `clinicId ∉ ctx.clinicIds` → **403** (`SyncScopeError`) ;
 *  - succès → **200** `{ blockStart, blockEnd, type, clinicId }` ;
 *  - toute autre exception → **500** générique (jamais de message interne).
 *
 * Invariants d'allocation :
 *  - **atomicité** : la ligne `(clinic_id, type)` est verrouillée
 *    `SELECT … FOR UPDATE` dans une transaction (créée avec
 *    `last_number = 0` si absente, dans cette même transaction) → deux postes
 *    ne peuvent jamais recevoir le même intervalle ;
 *  - **idempotence** : si un bloc `reserved` existe encore **pour CE MÊME
 *    device** et n'est pas épuisé (`cursor < block_end` ou absent), il est
 *    renvoyé tel quel, **zéro écriture** ;
 *  - **renouvellement** (6.1b) : bloc `reserved` de CE device mais **épuisé**
 *    (`cursor ≥ block_end`) → le bloc passe `consumed` puis un **nouveau** bloc
 *    disjoint est découpé au-delà de `last_number` ;
 *  - **jamais de vol** : un bloc `reserved` appartenant à **un autre** device
 *    n'est pas réattribué — un **nouveau** bloc est découpé au-delà de
 *    `last_number` (le bloc du premier device reste acquis) ;
 *  - **plancher anti-doublon** (6.1b) : avant de découper, `blockStart =
 *    max(last_number, highestIssued) + 1` où `highestIssued` est le numéro le
 *    plus élevé **réellement émis** (`invoice`/`quote`/`prosthesis_order`) → un
 *    compteur rétrogradé ne peut pas faire réémettre un numéro déjà imprimé ;
 *    `last_number` est aligné sur `blockEnd` dans la même écriture ;
 *  - **client menteur** : un `cursor` exagéré ne peut causer que des **trous**
 *    (le plancher est bâti sur les numéros **émis**, jamais sur le curseur
 *    déclaré) — **jamais de doublon**. C'est le comportement voulu ;
 *  - `now` est **toujours l'horloge serveur** ; zéro `console.log`,
 *    `console.error` uniquement sur les 500, sans secret ;
 *  - la route n'est jamais mise en cache (`force-dynamic`).
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Bornes et schéma du corps                                                   */
/* -------------------------------------------------------------------------- */

export const MIN_BLOCK_SIZE = 1;
export const MAX_BLOCK_SIZE = 200;
export const DEFAULT_BLOCK_SIZE = 50;

const blocksRequestSchema = z.object({
  clinicId: z.string().min(1),
  type: documentSequenceTypeSchema,
  size: z.number().int().min(MIN_BLOCK_SIZE).max(MAX_BLOCK_SIZE).optional(),
  cursor: z.number().int().min(0).optional(),
});

export type BlocksRequest = z.infer<typeof blocksRequestSchema>;

/** Corps contractuel d'une réservation réussie. */
export interface BlockReservation {
  blockStart: number;
  blockEnd: number;
  type: string;
  clinicId: string;
}

/* -------------------------------------------------------------------------- */
/* Réponses                                                                    */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "unauthorized" | "invalid-request" | "forbidden" | "internal-error",
  status: number,
): Response {
  return NextResponse.json({ error }, { status });
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <jeton>`, `null` sinon. */
function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/* -------------------------------------------------------------------------- */
/* Réservation atomique (chemin de production)                                 */
/* -------------------------------------------------------------------------- */

export type BlocksDb = typeof db;

export interface ReserveBlockParams {
  clinicId: string;
  type: string;
  size: number;
  /**
   * `last_number` local du poste = preuve que le bloc détenu est épuisé.
   * `cursor ≥ block_end` → renouvellement. Absent → jamais considéré épuisé
   * (renvoi idempotent du bloc courant).
   */
  cursor?: number;
}

/* -------------------------------------------------------------------------- */
/* Cœur testable (magasin de séquence + plancher injectés)                     */
/* -------------------------------------------------------------------------- */

/** Ligne `document_sequence` verrouillée (`FOR UPDATE`), colonnes utiles. */
export interface LockedSequenceRow {
  lastNumber: number;
  blockStart: number | null;
  blockEnd: number | null;
  blockDeviceId: string | null;
  blockStatus: string | null;
}

/**
 * Frontière d'accès à `document_sequence` (repo **mémoire** dans les tests,
 * Drizzle dans l'application). Chaque écriture est appelée sous le verrou
 * `FOR UPDATE` tenu par le orchestrateur {@link reserveBlockCore}.
 */
export interface SequenceStore {
  /** Crée la ligne `(clinicId, type)` si absente (`last_number = 0`). */
  insertIfAbsent(clinicId: string, type: string): Promise<void>;
  /** Ligne verrouillée `FOR UPDATE`, `null` si introuvable. */
  lockRow(clinicId: string, type: string): Promise<LockedSequenceRow | null>;
  /**
   * Découpe un nouveau bloc : pose `lastNumber = blockEnd` (aligne le compteur
   * au-dessus de tout numéro déjà émis), les bornes, le détenteur et
   * `block_status = 'reserved'`.
   */
  writeBlock(
    clinicId: string,
    type: string,
    patch: { blockStart: number; blockEnd: number; deviceId: string; now: Date },
  ): Promise<void>;
  /** Passe le bloc courant en `consumed` (renouvellement d'un bloc épuisé). */
  markConsumed(clinicId: string, type: string): Promise<void>;
}

/** Interrogateur du plancher : numéro le plus élevé réellement émis. */
export type HighestIssuedFinder = (clinicId: string, type: string) => Promise<number>;

/**
 * Réserve `[blockStart … blockEnd]` pour `ctx.deviceId` — **cœur pur** au-dessus
 * d'une {@link SequenceStore} et d'un plancher {@link HighestIssuedFinder}
 * injectés (testable hermétiquement).
 *
 * Décisions, dans l'ordre, sous le verrou (déjà tenu par l'appelant) :
 *  1. `insertIfAbsent` (ligne absente → `last_number = 0`) ;
 *  2. `lockRow` (`FOR UPDATE`) : le verrou sérialise deux réservations ;
 *  3. bloc `reserved` de CE device **non épuisé** (`cursor` absent ou
 *     `< block_end`) → renvoi idempotent, **zéro écriture** ;
 *  4. bloc `reserved` de CE device **épuisé** (`cursor ≥ block_end`) →
 *     `markConsumed` puis chute vers (5) pour couper un nouveau bloc ;
 *  5. sinon (pas de bloc, bloc d'un autre device, ou renouvellement) →
 *     `blockStart = computeBlockStart(last_number, highestIssued)`,
 *     `blockEnd = blockStart + size - 1`, `writeBlock` (une seule écriture aligne
 *     `last_number = blockEnd`) → réservation.
 *
 * @throws SyncScopeError si le cabinet est hors portée du jeton.
 */
export async function reserveBlockCore(
  store: SequenceStore,
  highestIssued: HighestIssuedFinder,
  ctx: DeviceTokenContext,
  params: ReserveBlockParams,
  now: Date,
): Promise<BlockReservation> {
  if (!ctx.clinicIds.includes(params.clinicId)) {
    throw new SyncScopeError();
  }

  // (1) Ligne absente → créée ici, dans la même transaction que le verrou.
  await store.insertIfAbsent(params.clinicId, params.type);

  // (2) Verrou d'allocateur : deux postes ne peuvent pas se partager un
  //     intervalle, quel que soit l'ordre d'arrivée.
  const row = await store.lockRow(params.clinicId, params.type);
  if (row === null) {
    // Inatteignable en normal : l'INSERT ci-dessus vient d'échouer silencieusement.
    throw new Error("sync/blocks : ligne de séquence introuvable après insertion.");
  }

  const heldByThisDevice =
    row.blockStatus === "reserved" &&
    row.blockDeviceId === ctx.deviceId &&
    row.blockStart !== null &&
    row.blockEnd !== null;

  // (3) Idempotence : bloc non épuisé de ce poste → renvoyé tel quel, zéro
  //     écriture (l'écraser ferait sauter des numéros).
  if (heldByThisDevice && (params.cursor === undefined || params.cursor < (row.blockEnd as number))) {
    return {
      blockStart: row.blockStart as number,
      blockEnd: row.blockEnd as number,
      type: params.type,
      clinicId: params.clinicId,
    };
  }

  // (4) Renouvellement : bloc de ce poste mais épuisé (preuve `cursor ≥
  //     block_end`) → marqué `consumed`, puis on découpe un nouveau bloc. Un
  //     client menteur (cursor exagéré) ne peut créer que des TROUS, jamais de
  //     doublons : le plancher de (5) ne dépend que des numéros ÉMIS.
  if (heldByThisDevice) {
    await store.markConsumed(params.clinicId, params.type);
  }

  // (5) Nouveau bloc — plancher anti-doublon : ne jamais repasser sous un numéro
  //     déjà imprimé même si `last_number` a rétrogradé.
  const issued = await highestIssued(params.clinicId, params.type);
  const blockStart = computeBlockStart(row.lastNumber, issued);
  const blockEnd = blockStart + params.size - 1;

  // Une seule écriture : `last_number = blockEnd ≥ blockStart > last_number`
  // (et `≥ highestIssued`) aligne définitivement le compteur au-dessus de tout
  // numéro déjà émis.
  await store.writeBlock(params.clinicId, params.type, {
    blockStart,
    blockEnd,
    deviceId: ctx.deviceId,
    now,
  });

  return { blockStart, blockEnd, type: params.type, clinicId: params.clinicId };
}

/* -------------------------------------------------------------------------- */
/* Adaptateur Drizzle (chemin de production)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Réserve un bloc contre la base réelle, dans UNE transaction :
 *  1. `INSERT … ON CONFLICT DO NOTHING` (ligne absente → `last_number = 0`) ;
 *  2. `SELECT … FOR UPDATE` sur `(clinic_id, type)` ;
 *  3. décision via {@link reserveBlockCore} (idempotence / renouvellement /
 *     nouveau bloc avec plancher) ;
 *  4. écritures (`markConsumed` puis `writeBlock`) → commit.
 *
 * @param now horloge **serveur** (jamais l'horloge client).
 * @throws SyncScopeError si le cabinet est hors portée du jeton.
 */
export async function reserveNumberBlock(
  ctx: DeviceTokenContext,
  params: ReserveBlockParams,
  now: Date,
  database: BlocksDb = db,
): Promise<BlockReservation> {
  return database.transaction(async (tx): Promise<BlockReservation> => {
    const store: SequenceStore = {
      async insertIfAbsent(clinicId, type) {
        await tx
          .insert(documentSequences)
          .values({ clinicId, type, lastNumber: 0 })
          .onConflictDoNothing();
      },
      async lockRow(clinicId, type) {
        const rows = await tx
          .select()
          .from(documentSequences)
          .where(and(eq(documentSequences.clinicId, clinicId), eq(documentSequences.type, type)))
          .for("update");
        const row = rows[0];
        if (row === undefined) return null;
        return {
          lastNumber: row.lastNumber,
          blockStart: row.blockStart,
          blockEnd: row.blockEnd,
          blockDeviceId: row.blockDeviceId,
          blockStatus: row.blockStatus,
        };
      },
      async writeBlock(clinicId, type, patch) {
        await tx
          .update(documentSequences)
          .set({
            lastNumber: patch.blockEnd,
            blockStart: patch.blockStart,
            blockEnd: patch.blockEnd,
            blockDeviceId: patch.deviceId,
            blockStatus: "reserved",
            blockReservedAt: patch.now,
          })
          .where(and(eq(documentSequences.clinicId, clinicId), eq(documentSequences.type, type)));
      },
      async markConsumed(clinicId, type) {
        await tx
          .update(documentSequences)
          .set({ blockStatus: "consumed" })
          .where(and(eq(documentSequences.clinicId, clinicId), eq(documentSequences.type, type)));
      },
    };

    return reserveBlockCore(
      store,
      (clinicId, type) => findHighestIssuedNumber(tx, clinicId, type),
      ctx,
      params,
      now,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncBlocksHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /** Réservation — chemin de prod : `reserveNumberBlock`. */
  reserve: (
    ctx: DeviceTokenContext,
    params: ReserveBlockParams,
    now: Date,
  ) => Promise<BlockReservation>;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncBlocksHandler(
  overrides: Partial<SyncBlocksHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const reserve =
    overrides.reserve ??
    ((ctx: DeviceTokenContext, p: ReserveBlockParams, now: Date) =>
      reserveNumberBlock(ctx, p, now));

  return async function POST(request: Request): Promise<Response> {
    // (1) Authentification — échec fermé, réponse générique (pas d'oracle).
    const token = readBearerToken(request.headers.get("authorization"));
    if (token === null) {
      return jsonError("unauthorized", 401);
    }
    let ctx: DeviceTokenContext | null;
    try {
      ctx = await verifyToken(token, new Date());
    } catch {
      console.error("[api/sync/blocks] échec imprévu de la vérification du jeton");
      return jsonError("internal-error", 500);
    }
    if (ctx === null) {
      return jsonError("unauthorized", 401);
    }

    // (2) Corps — JSON valide puis validation Zod (400 structuré).
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = blocksRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }

    // (3) Portée, réservation, erreurs — `now` = horloge serveur.
    try {
      if (!ctx.clinicIds.includes(parsed.data.clinicId)) {
        throw new SyncScopeError();
      }
      const reservation = await reserve(
        ctx,
        {
          clinicId: parsed.data.clinicId,
          type: parsed.data.type,
          size: parsed.data.size ?? DEFAULT_BLOCK_SIZE,
          cursor: parsed.data.cursor,
        },
        new Date(),
      );
      return NextResponse.json(reservation);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        return jsonError("forbidden", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/blocks] échec imprévu de la réservation du bloc");
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncBlocksHandler();
