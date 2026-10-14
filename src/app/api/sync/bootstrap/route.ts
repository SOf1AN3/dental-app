import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { syncOutbox, users } from "@/lib/db/schema";
import {
  applyPulledChanges,
  createLocalApplyRepo,
  type ApplyResult,
  type LocalApplyRepo,
} from "@/lib/sync/local-apply";
import {
  MAX_PULL_LIMIT,
  pullResponseSchema,
  type ChangeOp,
  type Cursor,
  type PullResponse,
} from "@/lib/sync/protocol";

/**
 * Tâche 7.1 — `POST /api/sync/bootstrap` (serveur Next **local** du poste) :
 * amorçage des données initiales d'une **installation neuve**.
 *
 * ## Pourquoi cette route existe
 *
 * Un desktop fraîchement installé a une base locale **vide** : aucun
 * utilisateur, aucun cabinet → le login local (`bcrypt` sur `user`) échoue
 * toujours. Le flux de bootstrap est donc :
 *
 *  1. l'utilisateur s'identifie sur le serveur **central** (côté main Electron,
 *     `POST /api/sync/token` — tâche 7.1) ;
 *  2. le jeton d'appareil est injecté dans l'env de cet enfant Next
 *     (`SYNC_TOKEN`, via redémarrage du processus) ;
 *  3. **cette route** tire les données initiales (utilisateurs, cabinets,
 *     memberships, puis l'ensemble du périmètre des cabinets demandés) via
 *     `POST {SYNC_BASE_URL}/api/sync/pull`, **plafonné** (20 pages / 5 000
 *     lignes) pour rester dans un temps de requête raisonnable ;
 *  4. le poste fait ensuite son login **local** (bcrypt), comme au quotidien.
 *
 * ## Contrat
 *
 *  - **authentification d'environnement** : `SYNC_TOKEN`, `SYNC_BASE_URL` et
 *    `DEVICE_ID` doivent être présents dans l'env de l'enfant (preuve d'une
 *    reconnexion réussie) — sinon **409 `{ error: "not-authenticated" }`**
 *    avec un message explicite « connectez-vous d'abord » (échec fermé : sans
 *    jeton, aucun tirage n'est possible) ;
 *  - corps `{ clinicIds: string[] }` **ou** `{ clinicId: string }` — au moins
 *    **un** cabinet requis, sinon **400 `invalid-request`** ;
 *  - succès → **200 `{ pulled, hasMore, cursor }`** (`pulled` = opérations
 *    reçues et confiées à `applyPulledChanges`, `hasMore` = le plafond a été
 *    atteint ou il reste des pages, `cursor` = dernier curseur serveur) ;
 *  - **toute** défaillance (réseau, central en 4xx/5xx, corps central
 *    malformé, base locale) → **500 `internal-error`** générique : aucun
 *    message interne, aucun jeton, aucune URL ne quittent le serveur ;
 *  - jamais mis en cache (`force-dynamic`), `console.error` sans secret.
 *
 * ## `password_hash` — ANALYSE ET DÉCISION (hypothèse D-8)
 *
 * **Constat vérifié** : le protocole interdit toute transmission du hash.
 * `TABLE_REGISTRY.user.columns` ne contient ni `passwordHash` ni
 * `password_hash` (`protocol.ts`), `FORBIDDEN_PAYLOAD_COLUMNS` les refoule,
 * `serializeRow()` projette sur la liste blanche — `central-store.fetchChanges`
 * émet donc toujours `payload: serializeRow(...)` (« B6 : `password_hash` ne
 * sort jamais »), `local-apply` **re-projette** (A2) et le test
 * `central-store.test.ts` verrouille « un tirage `user` ne contient JAMAIS
 * password_hash ».
 *
 * **Conséquence** : l'hypothèse D-8 (« la table `user` locale contient les
 * hashes ») est **fausse** avec le seul `pull` — un poste amorcé recevrait des
 * utilisateurs dont `password_hash` reste `NULL`, et `src/lib/auth.ts`
 * (`if (user?.passwordHash)`) refuserait alors **définitivement** tout login
 * local. Le bootstrap serait inopérant.
 *
 * **Décision implémentée ici** : accepter `password_hash` **uniquement** dans
 * la direction **serveur → poste** et **uniquement** via cette route :
 *
 *  - `applyPulledChanges()` continue de le **retirer** (A2, inchangé) : le
 *    chemin de pull normal (`electron/sync/runner.ts`) n'écrit **jamais** ce
 *    champ — vérifié par le test de ce fichier ;
 *  - seuls les `ChangeOp` de table `user` **tirés du central** alimentent une
 *    écriture dédiée ({@link extractUserPasswordHashes}), **bornée** à une
 *    valeur de forme bcrypt (regex) : aucune écriture de colonne arbitraire,
 *    aucun payload accepté en clair ;
 *  - **filtrage avant écriture** (tâche 7.1c) : le hash n'est écrit que si la
 *    ligne a **réellement été appliquée** dans ce lot — `applied.errors[].rowId`
 *    et la règle A1 (`isRowLocallyPending("user", …)` → `skipped-pending`) en
 *    sont exclus (voir {@link filterWritableHashWrites}). Sans ce filtre, le
 *    hash central écraserait un utilisateur ayant un changement local en attente
 *    de push — perte **définitive**, le protocole interdisant de pousser
 *    `password_hash` ;
 *  - la requête part **du serveur local vers le central configuré dans son
 *    env** (`SYNC_BASE_URL`) : le corps de l'appelant ne peut pas injecter de
 *    hash (il ne porte que des `clinicId`).
 *
 * **Pourquoi c'est acceptable** : la base vit sur le poste **du cabinet**,
 * chiffrement disque/DPAPI du même dossier `userData` ; le hash y est exactement
 * aussi exposé que sur le serveur qui l'a généré, et il est **nécessaire** au
 * contrôle bcrypt local (c'est la seule raison de son existence). Un central
 * compromis qui pousserait un hash de son choix ne gagnerait aucun droit qu'il
 * n'ait déjà pas : il détient déjà les comptes, les mots de passe (il vérifie
 * les logins) et toutes les données. À l'inverse, la direction poste → serveur
 * reste **interdite** : le push projette déjà les payloads (`serializeRow`), un
 * poste ne peut donc jamais rétro-verser un hash.
 *
 * ## Câblage côté central — FAIT (tâche 7.1b)
 *
 * Le central expose désormais cette variante via `POST /api/sync/pull` :
 * `pullRequestSchema.extend({ variant: z.literal("bootstrap").optional() })`
 * → `fetchChanges(..., { includeAuthBootstrap: true })`, qui ajoute
 * `passwordHash` **après** projection, **uniquement** aux opérations `user`
 * **vivantes** (voir `FetchChangesOptions` dans `central-store.ts`).
 *
 * Ce module envoie donc `variant: "bootstrap"` sur **chaque** page de son
 * tirage (corps de {@link fetchCentralPage}) — c'est ce qui « réveille » la
 * porte {@link extractUserPasswordHashes} ci-dessus. Le chemin quotidien de
 * `runner` reste inchangé : sans `variant`, la liste blanche s'applique
 * intégralement. Un `variant` inconnu côté central vaudrait **400** (valeur
 * fermée) → ici absorbé en 500 `internal-error` par la garde `!response.ok`,
 * donc jamais de silencieux : un central trop ancien refuserait l'amorçage au
 * lieu de livrer un hash falsifié.
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Plafonds (jamais de tirage sans limite)                                     */
/* -------------------------------------------------------------------------- */

/** Pages maximum par bootstrap (toutes cabinets confondus). */
export const MAX_BOOTSTRAP_PAGES = 20;
/** Opérations maximum recevables par bootstrap (toutes cabinets confondus). */
export const MAX_BOOTSTRAP_ROWS = 5_000;
/** Cabinets maximum traitables en une seule requête. */
export const MAX_BOOTSTRAP_CLINICS = 25;
/** Délai maximal d'un appel au central (échec fermé, jamais d'attente infinie). */
const CENTRAL_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Réponses                                                                    */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "not-authenticated" | "invalid-request" | "internal-error",
  status: number,
  message?: string,
): Response {
  return NextResponse.json(
    message === undefined ? { error } : { error, message },
    { status },
  );
}

/** 409 explicite : le poste n'a pas encore échangé ses identifiants. */
const NOT_AUTHENTICATED_MESSAGE =
  "Amorçage indisponible : connectez-vous d'abord (jeton d'appareil absent). " +
  "L'environnement du serveur local doit porter SYNC_TOKEN, SYNC_BASE_URL et DEVICE_ID.";

/* -------------------------------------------------------------------------- */
/* Corps de requête (Zod)                                                      */
/* -------------------------------------------------------------------------- */

const bootstrapRequestSchema = z
  .object({
    clinicIds: z.array(z.string().trim().min(1)).max(MAX_BOOTSTRAP_CLINICS).optional(),
    clinicId: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) =>
      (value.clinicIds !== undefined && value.clinicIds.length > 0) ||
      value.clinicId !== undefined,
    { message: "au moins un cabinet requis (clinicId ou clinicIds[])" },
  );

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

/** Normalise les deux formes de corps en une liste **dédupliquée** non vide. */
export function normalizeClinicIds(value: BootstrapRequest): string[] {
  const raw =
    value.clinicIds !== undefined && value.clinicIds.length > 0
      ? value.clinicIds
      : value.clinicId !== undefined
        ? [value.clinicId]
        : [];
  const seen = new Set<string>();
  const clinicIds: string[] = [];
  for (const id of raw) {
    if (!seen.has(id)) {
      seen.add(id);
      clinicIds.push(id);
    }
  }
  return clinicIds;
}

/* -------------------------------------------------------------------------- */
/* Environnement de bootstrap                                                  */
/* -------------------------------------------------------------------------- */

/** Triple requis dans l'env de l'enfant pour pouvoir tirer (sinon 409). */
export interface BootstrapCentralEnv {
  /** Jeton d'appareil (jamais journalisé, jamais renvoyé). */
  readonly token: string;
  /** Origine du central (validée par l'injecteur de env de production). */
  readonly baseUrl: string;
  readonly deviceId: string;
}

export type BootstrapEnvReader = () => BootstrapCentralEnv | null;

/**
 * Lecture de l'environnement de l'enfant — **échec fermé** : l'une des trois
 * clés absente (ou vide) signifie que le poste n'a pas encore réussi son
 * échange d'identifiants → `null` → 409. Aucune valeur n'est journalisée.
 */
function readBootstrapEnv(): BootstrapCentralEnv | null {
  const token = process.env.SYNC_TOKEN?.trim() ?? "";
  const baseUrl = process.env.SYNC_BASE_URL?.trim() ?? "";
  const deviceId = process.env.DEVICE_ID?.trim() ?? "";
  if (token === "" || baseUrl === "" || deviceId === "") {
    return null;
  }
  return { token, baseUrl, deviceId };
}

/* -------------------------------------------------------------------------- */
/* `password_hash` — extraction (seule porte d'entrée locale, cf. en-tête)      */
/* -------------------------------------------------------------------------- */

/** Écriture à effectuer : hash bcrypt d'un utilisateur **tiré** du central. */
export interface UserPasswordHashWrite {
  readonly userId: string;
  readonly hash: string;
}

/**
 * Forme bcrypt stricte (`$2a$`/`2b$`/`2y$` + coût 2 chiffres + 53 caractères
 * d'alphabét base64 `. / A-Za-z0-9` = 60 caractères). Toute autre valeur est
 * **refusée** : cette route n'écrit jamais une chaîne arbitraire dans une
 * colonne de sécurité.
 */
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Repère les hashes de mot de passe **présents dans les ops tirées**.
 *
 * Porte d'entrée **exclusive** (aucune autre route, aucun `pull` régulier ne
 * transmet ce champ — voir l'en-tête) : table `user` uniquement, opérations
 * vivantes (`insert`/`update`) uniquement, forme bcrypt exigée, dernier état
 * reçu gagnant. Le hash n'est **jamais** journalisé ni renvoyé.
 */
export function extractUserPasswordHashes(
  changes: readonly ChangeOp[],
): UserPasswordHashWrite[] {
  const byUser = new Map<string, string>();
  for (const change of changes) {
    if (change.table !== "user" || change.op === "delete") continue;
    const payload: Record<string, unknown> = change.payload;
    const candidate = payload.passwordHash ?? payload.password_hash;
    if (typeof candidate !== "string" || !BCRYPT_HASH_PATTERN.test(candidate)) {
      continue;
    }
    byUser.set(change.rowId, candidate);
  }
  return [...byUser].map(([userId, hash]) => ({ userId, hash }));
}

/* -------------------------------------------------------------------------- */
/* Chemin de production : requêtes à la base locale                            */
/* -------------------------------------------------------------------------- */

/**
 * **A1** — ligne possédant une entrée `pending` dans `sync_outbox` : ignorée
 * par l'application (le poste pousse d'abord la sienne). Requête paramétrée
 * Drizzle bornée à `idx_sync_outbox_status_seq`.
 */
async function isRowLocallyPendingDb(table: string, rowId: string): Promise<boolean> {
  const rows = await db
    .select({ id: syncOutbox.id })
    .from(syncOutbox)
    .where(
      and(
        eq(syncOutbox.tableName, table),
        eq(syncOutbox.rowId, rowId),
        eq(syncOutbox.status, "pending"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Écrit les hashes tirés dans `user.password_hash` — **uniquement** appelé
 * depuis cette route (voir l'en-tête).
 *
 *  - `UPDATE … WHERE id = ?` uniquement : la ligne doit **déjà** exister
 *    (appliquée par `applyPulledChanges` dans le même lot) — aucune création
 *    de ligne possible ici, jamais d'upsert d'une ligne partielle ;
 *  - 0 ligne mise à jour (ligne absente/supprimée) = hash non écrit, signalé
 *    par un compteur (jamais la valeur) : le login local restera impossible
 *    pour cet utilisateur, ce qui doit rester **visible** ;
 *  - Drizzle pose `updated_at` (`$onUpdate`) : sans écriture d'`sync_outbox`,
 *    la ligne n'est **pas** re-poussée — le central reste la source de vérité
 *    et le prochain tirage réalignera l'horodatage.
 */
async function writeUserPasswordHashesDb(
  writes: readonly UserPasswordHashWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  let applied = 0;
  for (const write of writes) {
    const rows = await db
      .update(users)
      .set({ passwordHash: write.hash })
      .where(eq(users.id, write.userId))
      .returning({ id: users.id });
    applied += rows.length;
  }
  if (applied !== writes.length) {
    // Compteurs seuls — le hash n'apparaît jamais dans un journal.
    console.warn(
      `[api/sync/bootstrap] ${applied}/${writes.length} hash de mot de passe écrit(s) ` +
        "(ligne utilisateur absente pour les autres).",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Filtrage des écritures de hash (tâche 7.1c — mineur 2)                      */
/* -------------------------------------------------------------------------- */

/**
 * Exclut du lot d'écriture les hashes dont la ligne **n'a pas été appliquée**
 * par `applyPulledChanges` dans ce même lot.
 *
 * Deux exclusions, toutes deux justifiées par « n'écrase jamais une ligne que
 * le tirage n'a pas alignée » :
 *
 *  1. **`applied.errors[].rowId`** (table `user`) : opération en échec — la
 *     ligne locale n'est pas l'état central, écrire le hash masquerait
 *     l'échec et donnerait l'illusion d'un compte réaligné ;
 *  2. **règle A1 (`skipped-pending`)** : `isRowLocallyPending("user", rowId)`
 *     renvoie `true` → le poste détient un changement **en attente de push**.
 *     Sans ce filtre, le hash tiré écraserait le hash local d'un utilisateur en
 *     cours de modification — le push suivant ne le referait pas (le protocole
 *     interdit de pousser `password_hash`) : la perte serait **définitive**.
 *
 * `isRowLocallyPending` n'est donc interrogé ici que pour les utilisateurs
 * **réellement extraits** (une requête indexée `idx_sync_outbox_status_seq`
 * par hash retenu — pas pour chaque ligne tirée).
 */
async function filterWritableHashWrites(
  writes: readonly UserPasswordHashWrite[],
  applied: ApplyResult,
  isRowLocallyPending: (table: string, rowId: string) => Promise<boolean>,
): Promise<UserPasswordHashWrite[]> {
  if (writes.length === 0) {
    return [];
  }
  const failedUserRowIds = new Set<string>();
  for (const error of applied.errors) {
    if (error.table === "user") {
      failedUserRowIds.add(error.rowId);
    }
  }
  const writable: UserPasswordHashWrite[] = [];
  for (const write of writes) {
    if (failedUserRowIds.has(write.userId)) {
      continue;
    }
    if (await isRowLocallyPending("user", write.userId)) {
      continue;
    }
    writable.push(write);
  }
  return writable;
}

/* -------------------------------------------------------------------------- */
/* Tirage paginé (cœur testable, deps injectées)                               */
/* -------------------------------------------------------------------------- */

/** Corps contractuel du bootstrap réussi. */
export interface BootstrapResult {
  /** Opérations reçues et confiées à `applyPulledChanges` (tous lots). */
  readonly pulled: number;
  /** `true` = plafond atteint ou pages restantes. */
  readonly hasMore: boolean;
  /** Dernier curseur serveur reçu (`null` si aucun lot). */
  readonly cursor: Cursor | null;
}

export interface BootstrapRunParams {
  readonly env: BootstrapCentralEnv;
  readonly clinicIds: readonly string[];
  readonly fetchImpl: typeof fetch;
  readonly repo: LocalApplyRepo;
  readonly isRowLocallyPending: (table: string, rowId: string) => Promise<boolean>;
  readonly writeUserPasswordHashes: (
    writes: readonly UserPasswordHashWrite[],
  ) => Promise<void>;
  readonly now: Date;
}

/** Réponse centrale malformée / réseau en échec : rejet absorbed en 500. */
class BootstrapCentralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapCentralError";
  }
}

/**
 * Une page `POST /api/sync/pull` auprès du central — jamais de secret en log.
 *
 * `variant: "bootstrap"` (tâche 7.1b) demande au central d'émettre
 * `passwordHash` sur les opérations `user` vivantes ; c'est la contrepartie
 * de {@link extractUserPasswordHashes}. Valeur **fermée** côté central : un
 * central qui ne la connaîtrait pas répond 400 et la garde `!response.ok`
 * convertit l'échec en `BootstrapCentralError` (500 générique) — jamais de
 * hash falsifié accepté silencieusement.
 */
async function fetchCentralPage(
  params: BootstrapRunParams,
  clinicId: string,
  cursor: Cursor | null,
): Promise<PullResponse> {
  const url = `${params.env.baseUrl.replace(/\/+$/, "")}/api/sync/pull`;
  let response: Response;
  try {
    response = await params.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.env.token}`,
      },
      body: JSON.stringify({
        clinicId,
        cursor,
        limit: MAX_PULL_LIMIT,
        variant: "bootstrap",
      }),
      signal: AbortSignal.timeout(CENTRAL_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error(`[api/sync/bootstrap] tirage central injoignable (${name})`);
    throw new BootstrapCentralError("central-injoignable");
  }
  if (!response.ok) {
    // Statut seul : ni corps ni URL de réponse ne sont journalisés.
    console.error(`[api/sync/bootstrap] tirage central refusé (HTTP ${response.status})`);
    throw new BootstrapCentralError("central-refuse");
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    console.error("[api/sync/bootstrap] corps central illisible");
    throw new BootstrapCentralError("central-illisible");
  }
  const parsed = pullResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[api/sync/bootstrap] réponse centrale malformée (pullResponseSchema)");
    throw new BootstrapCentralError("central-malforme");
  }
  return parsed.data;
}

/**
 * Boucle de tirage **plafonnée** : pour chaque cabinet, pages successives
 * (`cursor` repris) jusqu'à épuisement, `MAX_BOOTSTRAP_PAGES` pages ou
 * `MAX_BOOTSTRAP_ROWS` opérations. Chaque lot est appliqué immédiatement
 * (`applyPulledChanges`, isolement transactionnel par opération), puis les
 * hashes d'utilisateurs tirés sont écrits via la porte dédiée.
 *
 * @throws `BootstrapCentralError` (ou erreur locale) — capté en 500 par le handler.
 */
export async function runBootstrap(params: BootstrapRunParams): Promise<BootstrapResult> {
  let pulled = 0;
  let pages = 0;
  let cursor: Cursor | null = null;
  let lastPageHadMore = false;
  let capped = false;

  outer: for (const clinicId of params.clinicIds) {
    let clinicCursor: Cursor | null = null;
    let clinicHasMore = true;
    while (clinicHasMore) {
      if (pages >= MAX_BOOTSTRAP_PAGES || pulled >= MAX_BOOTSTRAP_ROWS) {
        capped = true;
        break outer;
      }
      const page = await fetchCentralPage(params, clinicId, clinicCursor);

      // (1) Application locale — A1 (`isRowLocallyPending`) + A2 (projection) :
      //     `password_hash` en est systématiquement retiré (voir en-tête).
      const applied = await applyPulledChanges(params.repo, page.changes, {
        isRowLocallyPending: params.isRowLocallyPending,
        now: params.now,
      });
      if (applied.errors.length > 0) {
        // Compteurs seuls : les motifs bruts peuvent porter des données.
        console.warn(
          `[api/sync/bootstrap] ${applied.errors.length} opération(s) en échec ignorée(s) (lot appliqué partiellement)`,
        );
      }

      // (2) Porte dédiée `password_hash` — table `user` + forme bcrypt
      //     **puis filtrage** (tâche 7.1c) : jamais d'écriture sur une ligne que
      //     ce tirage n'a PAS appliquée (erreurs + A1 `skipped-pending`) — sinon
      //     le hash central écraserait un changement local en attente.
      const hashWrites = extractUserPasswordHashes(page.changes);
      const writableHashWrites = await filterWritableHashWrites(
        hashWrites,
        applied,
        params.isRowLocallyPending,
      );
      if (writableHashWrites.length > 0) {
        await params.writeUserPasswordHashes(writableHashWrites);
      }
      const withheld = hashWrites.length - writableHashWrites.length;
      if (withheld > 0) {
        // Compteurs seuls — ni identifiant ni hash dans le journal.
        console.warn(
          `[api/sync/bootstrap] ${withheld} hash(s) de mot de passe non écrit(s) : ` +
            "ligne ignorée par le tirage (A1 en attente ou échec d'application).",
        );
      }

      pulled += page.changes.length;
      cursor = page.cursor;
      clinicCursor = page.cursor;
      pages += 1;
      clinicHasMore = page.hasMore;
      lastPageHadMore = page.hasMore;
    }
  }

  return { pulled, hasMore: capped || lastPageHadMore, cursor };
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncBootstrapHandlerDeps {
  /** Env de l'enfant (prod : `process.env` ; tests : objet injecté). */
  readEnv: BootstrapEnvReader;
  /** Appels au central (prod : `fetch` ; tests : stub). */
  fetchImpl: typeof fetch;
  /** Repo d'application locale (prod : Drizzle `db.ts` ; tests : mémoire). */
  createRepo: () => LocalApplyRepo;
  /** A1 — outbox `pending` (prod : requête Drizzle ; tests : spy). */
  isRowLocallyPending: (table: string, rowId: string) => Promise<boolean>;
  /** Écriture des hashes (prod : `UPDATE user` ; tests : spy). */
  writeUserPasswordHashes: (writes: readonly UserPasswordHashWrite[]) => Promise<void>;
  /** Horloge (prod : serveur ; tests : fixe). */
  now: () => Date;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base, aucun réseau) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncBootstrapHandler(
  overrides: Partial<SyncBootstrapHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const readEnv = overrides.readEnv ?? readBootstrapEnv;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const createRepo = overrides.createRepo ?? (() => createLocalApplyRepo(db));
  const isRowLocallyPending = overrides.isRowLocallyPending ?? isRowLocallyPendingDb;
  const writeUserPasswordHashes =
    overrides.writeUserPasswordHashes ?? writeUserPasswordHashesDb;
  const now = overrides.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    // (1) Authentification d'environnement — AVANT tout corps, avant tout
    //     réseau : sans jeton, on répond 409 « connectez-vous d'abord ».
    //     La triade est re-vérifiée ici (et non seulement par le lecteur par
    //     défaut) : un env réduit à des espaces compte comme **absent**.
    const env = readEnv();
    if (
      env === null ||
      env.token.trim() === "" ||
      env.baseUrl.trim() === "" ||
      env.deviceId.trim() === ""
    ) {
      return jsonError("not-authenticated", 409, NOT_AUTHENTICATED_MESSAGE);
    }

    // (2) Corps — JSON valide puis validation Zod (au moins un cabinet).
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = bootstrapRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    const clinicIds = normalizeClinicIds(parsed.data);
    if (clinicIds.length === 0) {
      // Garde redondante avec `refine` : jamais de boucle sans cabinet.
      return jsonError("invalid-request", 400);
    }

    // (3) Tirage plafonné + application — 500 générique sur toute défaillance.
    try {
      const result = await runBootstrap({
        env,
        clinicIds,
        fetchImpl,
        repo: createRepo(),
        isRowLocallyPending,
        writeUserPasswordHashes,
        now: now(),
      });
      return NextResponse.json(result);
    } catch (error) {
      // Message du seul `name` : ni jeton, ni URL, ni détail interne.
      const name = error instanceof Error ? error.name : "unknown";
      console.error(`[api/sync/bootstrap] amorçage impossible (${name})`);
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncBootstrapHandler();
