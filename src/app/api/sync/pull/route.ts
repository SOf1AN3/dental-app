import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { syncState } from "@/lib/db/schema";
import {
  SyncScopeError,
  fetchChanges,
  type FetchChangesOptions,
} from "@/lib/sync/central-store";
import { verifyDeviceToken, type DeviceTokenContext } from "@/lib/sync/central-auth";
import {
  pullRequestSchema,
  type PullRequest,
  type PullResponse,
} from "@/lib/sync/protocol";

/**
 * Tâche 5.2c — `POST /api/sync/pull` : tirage paginé des changements du
 * serveur central (voir `src/lib/sync/central-store.ts`).
 *
 * **POST plutôt que GET** : le curseur composite `(updated_at, id)` et les
 * options (`limit`) voyagent dans le corps — un GET ne devrait pas porter un
 * corps de requête. (Le plan §5.2 évoquait `GET` ; la décision d'implémentation
 * retient POST pour les raisons ci-dessus — le client de l'étape 6 s'aligne.)
 *
 * Contrat :
 *  - `Authorization: Bearer <jeton d'appareil>` — jeton absent / malformé /
 *    inconnu / révoqué / expiré → **401** (message générique), **avant**
 *    toute lecture/validation du corps ;
 *  - corps validé par `pullRequestSchema` + `variant` → sinon **400** ;
 *  - **anti-IDOR au niveau route** : le `clinicId` demandé doit appartenir à
 *    `ctx.clinicIds` → sinon **403** (verrou supplémentaire, en plus du
 *    filtrage SQL et de la re-vérification pure déjà posés dans le store) ;
 *  - succès → **200** avec la `PullResponse` (`changes`, `cursor`, `hasMore`) ;
 *  - `SyncScopeError` → **403** ; toute autre exception → **500** générique.
 *
 * Invariants : `now` toujours serveur ; zéro `console.log` ; `console.error`
 * uniquement sur les 500, sans secret ; jamais mis en cache (`force-dynamic`).
 *
 * ## Tâche 7.1b — `variant: "bootstrap"` (variante amorçage)
 *
 * Champ **optionnel et à valeur fermée** : `z.literal("bootstrap")` — toute
 * autre valeur (`"malveillant"`, `"admin"`, …) échoue la validation → **400**
 * (une valeur ouverte ne serait pas reconnue ni journalisée correctement).
 *
 *  - `variant` absent → appel au store **strictement inchangé** (aucun
 *    `options`, donc aucun `passwordHash` dans la réponse) ;
 *  - `variant: "bootstrap"` → `fetchChanges(..., { includeAuthBootstrap: true })`
 *    : le store ajoute `passwordHash` **uniquement** sur les opérations
 *    `user` **vivantes** (voir `FetchChangesOptions`) ;
 *  - le transport reste protégé par le même chemin : **auth (401) → corps
 *    (400) → anti-IDOR (403)**, aucun ordre n'est modifié ;
 *  - **journalisation** : le premier tirage bootstrap émis pour un device
 *    donné lève un `console.warn` **sans secret** (device, clinic, horloge —
 *    **jamais** le hash ni aucun mot de passe), puis ce device est marqué :
 *    les tirages suivants ne sont plus journalisés (pas de bruit, acte
 *    sensible traçable une fois). Choix du **log** plutôt que `audit_log` :
 *    cette route ne détient aucun `actorUserId` (auth = jeton d'appareil) et
 *    écrire dans `audit_log` (table `push-only`, créée par les postes)
 *    imposerait un horodatage/une portée d'audit artificiels — hors périmètre
 *    de la tâche et non couvert par le dépôt « simplement ».
 *
 * ## Plafond d'émission (tâche 7.1c — mineur 3)
 *
 * Le `console.warn` ci-dessus ne **borne** rien : sans état persiste, tout
 * détenteur de jeton peut réémettre `variant: "bootstrap"` à volonté et
 * re-tirer les hashes après **chaque** rotation de mot de passe (un poste
 * compromis n'a qu'à rejouer la variante).
 *
 * **Choix : marqueur `sync_state` côté central** — clé
 * `central-bootstrap-emitted:<deviceId>`, valeur
 * `{ firstAt, lastAt, pages }` (jsonb) :
 *
 *  - la colonne `last_bootstrap_at` **n'existe pas** sur `device` (schéma lu :
 *    `id, clinic_id, user_id, name, os, first_seen_at, last_seen_at,
 *    last_sync_at, trust_expires_at, trust_revoked_at, token_hash, rev,
 *    updated_at, created_at`), et **générer une migration est interdit** dans
 *    cette tâche ;
 *  - **aucune colonne de `device` n'est réutilisable proprement** :
 *    `last_sync_at`/`last_seen_at` sont réécrits par le runner et par
 *    `grantTrust` (sémantique « dernier cycle » — les trafiquer corromprait le
 *    suivi de synchro), `rev` est **monotone attribué au serveur** (jamais
 *    incrémenté côté app), `token_hash`/`trust_*` portent la confiance D-8 ;
 *  - `sync_state` (clé→valeur, migration `0020`) existe **dans le même
 *    schéma sur les deux pôles** : c'est le seul état persistant disponible
 *    sans migration. Sa doc l'assigne aux curseurs locaux, mais la table est
 *    partagée — on y range un marqueur **de central**, jamais lu par le poste.
 *
 * **Règle appliquée** ({@link allowAndAdvance}) : émission autorisée tant que
 * (a) le marqueur a moins de `BOOTSTRAP_ISSUE_WINDOW_MS` (6 h, couvre la fenêtre
 * d'installation : pages multiples, rejeux, redémarrages) **et** (b) le compte
 * cumulé reste sous `MAX_BOOTSTRAP_PAGES_LIFETIME` (40 = 2 × le plafond
 * `MAX_BOOTSTRAP_PAGES` d'une exécution). Au-delà → **409
 * `bootstrap-already-issued`**. La fenêtre est ancrée sur `firstAt` (jamais
 * repoussée) : elle ne peut pas être prolongée par des rejeux.
 *
 * **Limite assumée** : sans colonne dédiée, un poste **réinstallé** (même
 * `deviceId`, qui survit aux réinstallations) au-delà des 6 h doit être
 * ré-autorisé manuellement (purge de la clé `sync_state`) — ajouter
 * `device.last_bootstrap_at` par migration est la correction définitive,
 * explicitement hors périmètre ici. La variante reste donc bornée, jamais
 * émissible à vie.
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Corps (Zod) — `pullRequestSchema` + `variant` fermé (tâche 7.1b)            */
/* -------------------------------------------------------------------------- */

/**
 * Corps exact de cette route : le schéma du protocole (`pullRequestSchema`,
 * **non modifié** — `protocol.ts` est verrouillé) étendu d'un seul champ à
 * **valeur fermée**. Toute autre valeur que `"bootstrap"` échoue la
 * validation → **400 `invalid-request`** ; `variant` absent → tirage normal.
 */
const pullBodySchema = pullRequestSchema.extend({
  variant: z.literal("bootstrap").optional(),
});

type PullBody = z.infer<typeof pullBodySchema>;

/* -------------------------------------------------------------------------- */
/* Réponses                                                                   */
/* -------------------------------------------------------------------------- */

function jsonError(
  error:
    | "unauthorized"
    | "invalid-request"
    | "clinic-out-of-scope"
    | "bootstrap-already-issued"
    | "internal-error",
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
/* Plafond de la variante bootstrap (tâche 7.1c) — voir en-tête                */
/* -------------------------------------------------------------------------- */

/** Préfixe des clés `sync_state` réservées à ce plafond (jamais lues ailleurs). */
const BOOTSTRAP_STATE_KEY_PREFIX = "central-bootstrap-emitted:";
/**
 * Fenêtre d'émission **ancrée sur le premier tirage** (6 h) : couvre l'installation
 * d'un poste (pages multiples, rejeux réseau, redémarrages dans la foulée) sans
 * jamais être repoussée par un rejeu — `firstAt` n'est jamais réécrit.
 */
const BOOTSTRAP_ISSUE_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Pages bootstrap cumulées autorisées **par device** : 2 × le plafond
 * `MAX_BOOTSTRAP_PAGES` (20) d'une exécution de `/api/sync/bootstrap` — deux
 * amorçages complets, pas trois cents.
 */
const MAX_BOOTSTRAP_PAGES_LIFETIME = 40;

/** Marqueur persisté (jsonb) : un device, ses pages bootstrap, ses horodatages. */
interface BootstrapEmissionMarker {
  /** ISO — premier tirage bootstrap **jamais** émis (ancrage de la fenêtre). */
  readonly firstAt: string;
  /** ISO — dernier tirage émis (observation seule, pas de fenêtre glissante). */
  readonly lastAt: string;
  /** Pages bootstrap cumulées (incrémentées à chaque émission autorisée). */
  readonly pages: number;
}

/** Lecture defensive du jsonb : toute valeur absente/illisible = « pas de marqueur ». */
function parseBootstrapMarker(value: unknown): BootstrapEmissionMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<Record<string, unknown>>;
  if (
    typeof raw.firstAt !== "string" ||
    typeof raw.lastAt !== "string" ||
    typeof raw.pages !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(Date.parse(raw.firstAt)) || !Number.isInteger(raw.pages)) {
    return null;
  }
  return { firstAt: raw.firstAt, lastAt: raw.lastAt, pages: raw.pages };
}

/**
 * Règle pure de plafonnement : `allowed` = l'émission demandée est autorisée ;
 * `next` = valeur **à persister** dans ce cas (non pertinente sinon).
 *
 * Une fenêtre **ancrée** (`firstAt`) et non glissante : chaque rejeu prolonge
 * `lastAt` mais ne déplace jamais l'échéance — un poste compromis ne peut pas
 * maintenir la porte ouverte en tirant en continu.
 */
function allowAndAdvance(
  marker: BootstrapEmissionMarker | null,
  now: Date,
): { readonly allowed: boolean; readonly next: BootstrapEmissionMarker } {
  const iso = now.toISOString();
  if (marker === null) {
    return { allowed: true, next: { firstAt: iso, lastAt: iso, pages: 1 } };
  }
  const ageMs = now.getTime() - Date.parse(marker.firstAt);
  const allowed =
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= BOOTSTRAP_ISSUE_WINDOW_MS &&
    marker.pages < MAX_BOOTSTRAP_PAGES_LIFETIME;
  return {
    allowed,
    next: { firstAt: marker.firstAt, lastAt: iso, pages: marker.pages + 1 },
  };
}

/**
 * Repli **mémoire** (par processus) : marqueur de secours si `sync_state` est
 * illisible, **et** implémentation par défaut de la fabrique (tests hermétiques :
 * aucun accès base). Bornée exactement par la même règle — le défaut n'est donc
 * jamais « libre ».
 */
const bootstrapEmissionMemory = new Map<string, BootstrapEmissionMarker>();

async function reserveBootstrapEmissionMemory(
  deviceId: string,
  now: Date,
): Promise<boolean> {
  const { allowed, next } = allowAndAdvance(bootstrapEmissionMemory.get(deviceId) ?? null, now);
  if (allowed) {
    bootstrapEmissionMemory.set(deviceId, next);
  }
  return allowed;
}

/**
 * Réservation **persistante** côté central (`sync_state`) — chemin de prod de
 * `POST` (tâche 7.1c).
 *
 * Lecture-comparaison-écriture : concurrence prise au **pire** sur un compteur
 * (la fenêtre `firstAt`, elle, n'est jamais repoussée — le plafond dur reste
 * garanti même avec deux écritures simultanées perdues). Toute défaillance de la
 * base bascule sur {@link reserveBootstrapEmissionMemory} (**échec fermé borné**,
 * jamais d'ouverture silencieuse) et n'est jamais un refus : une base en
 * panne ne doit pas empêcher l'amorçage d'un poste sain.
 */
async function reserveBootstrapEmissionDb(
  deviceId: string,
  now: Date,
): Promise<boolean> {
  const key = `${BOOTSTRAP_STATE_KEY_PREFIX}${deviceId}`;
  try {
    const rows = await db
      .select({ value: syncState.value })
      .from(syncState)
      .where(eq(syncState.key, key))
      .limit(1);
    const { allowed, next } = allowAndAdvance(
      rows.length === 0 ? null : parseBootstrapMarker(rows[0].value),
      now,
    );
    if (!allowed) {
      return false;
    }
    if (rows.length === 0) {
      await db
        .insert(syncState)
        .values({ key, value: next, updatedAt: now })
        .onConflictDoNothing({ target: syncState.key });
    } else {
      await db.update(syncState).set({ value: next, updatedAt: now }).where(eq(syncState.key, key));
    }
    return true;
  } catch {
    // Journal **sans valeur** : ni deviceId ni marqueur ne quittent ce serveur.
    console.error(
      "[api/sync/pull] marqueur de variante bootstrap illisible : plafond mémoire local appliqué",
    );
    return reserveBootstrapEmissionMemory(deviceId, now);
  }
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncPullHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /**
   * Tirage paginé — chemin de prod : `fetchChanges`.
   *
   * `options` (4ᵉ argument, **optionnel**) ne porte que la variante
   * « bootstrap » (`{ includeAuthBootstrap: true }`) ; `undefined` signifie
   * un tirage strictement normal. Les implémentations sans 4ᵉ paramètre
   * (tests existants) restent compatibles.
   */
  pull: (
    ctx: DeviceTokenContext,
    req: PullRequest,
    now: Date,
    options?: FetchChangesOptions,
  ) => Promise<PullResponse>;
  /**
   * Réservation de l'émission `variant: "bootstrap"` (tâche 7.1c) :
   * `true` = autorisée **et décomptée**, `false` = plafond atteint → **409
   * `bootstrap-already-issued`**. **Optionnel** : les implémentations de test
   * existantes (2ᵉ, 3ᵉ argument seuls) continuent de fonctionner et retombent
   * sur le plafond mémoire de la fabrique ; le chemin de prod fournit
   * explicitement {@link reserveBootstrapEmissionDb} (`sync_state` côté central).
   */
  reserveBootstrapEmission?: (deviceId: string, now: Date) => Promise<boolean>;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncPullHandler(
  overrides: Partial<SyncPullHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const pull =
    overrides.pull ??
    ((ctx: DeviceTokenContext, req: PullRequest, now: Date, options?: FetchChangesOptions) =>
      fetchChanges(ctx, req, now, undefined, options));
  // Plafond de variante bootstrap (7.1c) : mémoire par défaut (hermétique) ;
  // `POST` injecte l'implémentation persistante `sync_state`.
  const reserveBootstrapEmission =
    overrides.reserveBootstrapEmission ?? reserveBootstrapEmissionMemory;

  // Traçabilité (7.1b) : devices déjà journalisés en « tirage bootstrap ».
  // Portée = cette instance de handler (le `POST` de prod est créé une fois
  // par chargement de module). Croissance bornée au nombre d'appareils.
  const bootstrapLoggedDevices = new Set<string>();
  // Traçabilité (7.1c) : refus de plafond journalisés **une fois** par device —
  // un poste en boucle ne doit pas saturer le journal du serveur central.
  const bootstrapRefusedDevices = new Set<string>();

  return async function POST(request: Request): Promise<Response> {
    // (1) Authentification — échec fermé, réponse générique (pas d'oracle).
    //     AVANT toute lecture du corps : un `variant` malveillant sans jeton
    //     reste un 401, jamais un 400 (aucune oracle de validation).
    const token = readBearerToken(request.headers.get("authorization"));
    if (token === null) {
      return jsonError("unauthorized", 401);
    }
    let ctx: DeviceTokenContext | null;
    try {
      ctx = await verifyToken(token, new Date());
    } catch {
      console.error("[api/sync/pull] échec imprévu de la vérification du jeton");
      return jsonError("internal-error", 500);
    }
    if (ctx === null) {
      return jsonError("unauthorized", 401);
    }

    // (2) Corps — JSON valide puis validation Zod (`variant` fermé → 400).
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = pullBodySchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    // `variant` est consigné SÉPARÉMENT : le store ne reçoit jamais le corps
    // brut, et `PullRequest` ne change pas de forme.
    const { variant, ...body }: PullBody = parsed.data;
    const req: PullRequest = body;
    const options: FetchChangesOptions | undefined =
      variant === "bootstrap" ? { includeAuthBootstrap: true } : undefined;

    // (3) Anti-IDOR au niveau route : le cabinet réclamé doit être dans la
    //     portée du jeton (`clinic_membership` actif, dérivé à l'émission).
    if (!ctx.clinicIds.includes(req.clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (3bis) Plafond d'émission de la variante bootstrap (tâche 7.1c) —
    //      **après** auth (401), corps (400) et anti-IDOR (403) : l'ordre du
    //      transport est strictement conservé, et le refus ne révèle l'existence
    //      d'aucun cabinet. **Avant** le tirage : la page est réservée même si
    //      le `pull` échoue ensuite (aucun décompte contournable).
    if (variant === "bootstrap") {
      let reserved: boolean;
      try {
        reserved = await reserveBootstrapEmission(ctx.deviceId, new Date());
      } catch {
        // Dépôt injecté défaillant : repli borné, jamais d'ouverture silencieuse.
        console.error("[api/sync/pull] réservation bootstrap impossible : plafond mémoire local appliqué");
        reserved = await reserveBootstrapEmissionMemory(ctx.deviceId, new Date());
      }
      if (!reserved) {
        if (!bootstrapRefusedDevices.has(ctx.deviceId)) {
          bootstrapRefusedDevices.add(ctx.deviceId);
          console.warn(
            `[api/sync/pull] variante bootstrap REFUSÉE pour device ${ctx.deviceId} : ` +
              "plafond d'émission atteint (fenêtre d'amorçage dépassée)",
          );
        }
        return jsonError("bootstrap-already-issued", 409);
      }
    }

    // (4) Tirage — `now` horloge serveur ; curseur paginé côté store.
    try {
      const response: PullResponse = await pull(ctx, req, new Date(), options);
      if (variant === "bootstrap" && !bootstrapLoggedDevices.has(ctx.deviceId)) {
        // 7.1b — acte sensible, journalisé UNE fois par device, **sans secret** :
        // ni hash, ni mot de passe, ni payload ne figurent dans ce journal.
        bootstrapLoggedDevices.add(ctx.deviceId);
        console.warn(
          `[api/sync/pull] tirage bootstrap émis pour device ${ctx.deviceId} ` +
            `(clinic ${req.clinicId})`,
        );
      }
      return NextResponse.json(response);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        return jsonError("clinic-out-of-scope", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/pull] échec imprévu du tirage");
      return jsonError("internal-error", 500);
    }
  };
}

// Chemin de prod : plafond persistant (`sync_state` côté central, 7.1c) — les
// fabriques de test (deps mémoire) n'utilisent jamais cette implémentation.
export const POST = createSyncPullHandler({
  reserveBootstrapEmission: reserveBootstrapEmissionDb,
});
