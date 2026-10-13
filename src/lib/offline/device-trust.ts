/**
 * D-8 — Logique de confiance d'appareil (hors-ligne).
 *
 * L'application de bureau fonctionne hors-ligne : bcrypt tourne localement et le
 * login local n'a besoin ni d'internet ni du serveur central. Cette couche est le
 * contrôle qui limite dans le temps (30 j par défaut) l'autorisation d'authentifier
 * hors-ligne un poste, avec révocation possible par le serveur central.
 *
 * Conception :
 * - Toute la décision est portée par `evaluateTrust`, **fonction pure** sans I/O.
 * - L'accès au stockage passe par `DeviceTrustRepo`, **injecté** : les tests sont
 *   hermétiques (repo en mémoire, aucun appel réseau, aucune base).
 * - `isCentralReachable` ne contacte que le serveur central : l'origine de
 *   l'URL fournie doit être **strictement égale** à celle de `SYNC_BASE_URL`
 *   (lu via `readSyncBaseUrl`, lecture protégée — garde-fou SSRF fail-closed)
 *   — aucun autre
 *   hôte n'est joignable, aucun secret, aucun en-tête d'authentification.
 *   Elle **ne lève jamais** (env absente, URL divergente, réseau absent,
 *   DNS invalide, timeout → `false`).
 * - Aucune journalisation ici : les éventuelles traces se feront dans
 *   `src/lib/auth.ts`, au niveau de l'appelant.
 */

/** Durée de confiance ouverte par un échange en ligne : 30 jours. */
export const DEFAULT_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Ligne de confiance telle que lue depuis le registre (miroir de la table `device`). */
export interface DeviceTrustRecord {
  id: string;
  userId: string | null;
  clinicId: string | null;
  name?: string;
  os?: string;
  /** Jamais modifié après la création de la ligne (le repo en garantit la pérennité). */
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Fenêtre de confiance ; nulle = aucun octroi en cours. */
  trustExpiresAt: Date | null;
  /** Coupure posée par le serveur central ; non nulle = révoqué, prime sur tout. */
  trustRevokedAt: Date | null;
}

/**
 * Champs modifiables via `upsert`. `id` (clé) et `firstSeenAt` sont exclus au
 * niveau du type : la pérennité de `firstSeenAt` sur une ligne existante est
 * garantie par le typage, pas seulement par la convention.
 */
export type DeviceTrustPatch = Partial<Omit<DeviceTrustRecord, "id" | "firstSeenAt">>;

/**
 * Accès au registre local de confiance. Injecté pour que cette couche reste
 * testable sans base. Implémentation SQL branchée dans `src/lib/auth.ts` (3.2).
 */
export interface DeviceTrustRepo {
  /** Lit la ligne du poste, `null` si inconnu. */
  get(deviceId: string): Promise<DeviceTrustRecord | null>;
  /**
   * Crée la ligne (valeurs par défaut : aucun userId, aucune confiance) ou
   * applique `patch` aux champs présents. `firstSeenAt` n'est jamais modifié
   * sur une ligne existante. Retourne la ligne résultante.
   */
  upsert(deviceId: string, patch: DeviceTrustPatch): Promise<DeviceTrustRecord>;
  /** Met à jour uniquement `lastSeenAt` (no-op si la ligne n'existe pas). */
  touch(deviceId: string, at: Date): Promise<void>;
}

export type TrustDecision =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "missing" | "expired" | "revoked" | "user-mismatch" };

/**
 * Décision **pure** (aucune I/O) : applique l'ordre de priorité D-8.
 *
 * 1. pas de ligne            → `missing`
 * 2. `trustRevokedAt` non nul → `revoked` (prime sur tout le reste)
 * 3. expiry nulle/passée, ou horloge/caducité invalide → `expired` (fail-closed)
 * 4. `userId` différent       → `user-mismatch`
 */
export function evaluateTrust(
  record: DeviceTrustRecord | null,
  userId: string,
  now: Date,
): TrustDecision {
  if (!record) {
    return { ok: false, reason: "missing" };
  }
  // La révocation prime : elle efface toute autre considération (date encore valide comprise).
  if (record.trustRevokedAt) {
    return { ok: false, reason: "revoked" };
  }
  const expiresAt = record.trustExpiresAt;
  const nowTs = now.getTime();
  if (
    !expiresAt ||
    !Number.isFinite(nowTs) ||
    !Number.isFinite(expiresAt.getTime()) ||
    nowTs >= expiresAt.getTime()
  ) {
    // Fail-closed : horloge client fausse (NaN) ou date caduque → refus déterministe.
    return { ok: false, reason: "expired" };
  }
  if (record.userId !== userId) {
    return { ok: false, reason: "user-mismatch" };
  }
  return { ok: true, expiresAt };
}

export interface GrantTrustParams {
  deviceId: string;
  userId: string;
  /** Renseigné si connu au moment de l'échange en ligne (jamais effacé si omis). */
  clinicId?: string | null;
  /** Nom d'hôte / libellé du poste. */
  name?: string;
  /** Plateforme, ex. `win32`. */
  os?: string;
  /** Durée de la fenêtre ; défaut `DEFAULT_TRUST_TTL_MS` (30 j). */
  ttlMs?: number;
}

/**
 * Ouvre ou renouvelle la confiance d'un poste — **à n'appeler qu'après un
 * échange en ligne réussi** (l'atteignabilité du serveur relève de
 * l'appelant via `isCentralReachable`, pas ici).
 *
 * - Poste inconnu : création + première expiration (`firstSeenAt` = `now`).
 * - Poste connu : expiration repoussée, `firstSeenAt` préservé, rattachement
 *   éventuel à un autre compte (un nouvel échange en ligne autorise le transfert).
 * - Poste révoqué : **aucune écriture**, la révocation n'est levée que par le
 *   serveur central, jamais par un octroi local.
 */
export async function grantTrust(
  repo: DeviceTrustRepo,
  params: GrantTrustParams,
  now: Date,
): Promise<TrustDecision> {
  const existing = await repo.get(params.deviceId);
  if (existing?.trustRevokedAt) {
    return { ok: false, reason: "revoked" };
  }

  const requestedTtl = params.ttlMs ?? DEFAULT_TRUST_TTL_MS;
  const ttlMs = Number.isFinite(requestedTtl) ? requestedTtl : DEFAULT_TRUST_TTL_MS;
  const patch: DeviceTrustPatch = {
    userId: params.userId,
    trustExpiresAt: new Date(now.getTime() + ttlMs),
    lastSeenAt: now,
  };
  // On ne patch que ce qui est fourni : un champ omis ne doit jamais effacer
  // l'information déjà connue (clinicId, nom d'hôte...).
  if (params.clinicId !== undefined) patch.clinicId = params.clinicId;
  if (params.name !== undefined) patch.name = params.name;
  if (params.os !== undefined) patch.os = params.os;

  const record = await repo.upsert(params.deviceId, patch);
  return evaluateTrust(record, params.userId, now);
}

/**
 * Vérifie la confiance d'un poste (chemin hors-ligne) et trace la tentative en
 * mettant à jour `lastSeenAt` dès qu'une ligne existe.
 */
export async function checkTrust(
  repo: DeviceTrustRepo,
  deviceId: string,
  userId: string,
  now: Date,
): Promise<TrustDecision> {
  const record = await repo.get(deviceId);
  if (!record) {
    return { ok: false, reason: "missing" };
  }
  await repo.touch(deviceId, now);
  return evaluateTrust(record, userId, now);
}

/**
 * Révoque localement la confiance d'un poste (déclenchée par l'appelant, ex.
 * signal du serveur ou décision admin). Idempotent : une révocation déjà posée
 * conserve sa date d'origine ; un poste inconnu est ignoré (aucune ligne fantôme).
 */
export async function revokeTrustLocally(
  repo: DeviceTrustRepo,
  deviceId: string,
  now: Date,
): Promise<void> {
  const record = await repo.get(deviceId);
  if (!record || record.trustRevokedAt) {
    return;
  }
  await repo.upsert(deviceId, { trustRevokedAt: now });
}

/**
 * Origine http(s) de `SYNC_BASE_URL`, ou `undefined` si l'env est absente,
 * malformée ou de protocole non supporté (fail-closed).
 */
function resolveAllowedOrigin(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Lit `SYNC_BASE_URL` depuis l'environnement **sans jamais lever**.
 *
 * Ce module est destiné au **serveur (Node)** : c'est là que vit le garde-fou
 * SSRF, entre l'appelant (`src/lib/auth.ts`) et `fetch`. Le `try/catch` existe
 * malgré tout parce que, dans un bundle **navigateur** sans `process`, la
 * simple lecture de `process.env` lèverait un `ReferenceError` **avant** le
 * fail-closed — violant ainsi le contrat « ne lève jamais »
 * d'`isCentralReachable`. Comportement inchangé sous Node : la valeur est lue
 * telle quelle, `undefined` si la variable est absente.
 */
function readSyncBaseUrl(): string | undefined {
  try {
    return process.env.SYNC_BASE_URL;
  } catch {
    return undefined;
  }
}

/**
 * Dit si le serveur central répond. **Ne lève jamais** : env absente,
 * origine divergente, URL malformée, réseau coupé, DNS en échec, timeout
 * borné → `false`.
 *
 * Garde-fou **SSRF** (fail-closed) : la fonction lit elle-même
 * `SYNC_BASE_URL` (via `readSyncBaseUrl`, lecture protégée) et refuse — **sans
 * aucun appel réseau** — toute URL dont l'**origine diffère** de celle de l'env
 * (comparaison stricte
 * schéma + hôte + port, normalisés par `new URL(...).origin`). Un paramètre
 * détourné (hôte interne, `file:`, `javascript:`, URL d'un tiers) est donc
 * rejeté par construction. Aucun secret, aucun en-tête d'authentification.
 * Toute réponse HTTP — même 4xx/5xx — prouve que le serveur est joignable ;
 * la politique applicative (statut, corps) relève de l'appelant.
 */
export async function isCentralReachable(
  baseUrl: string | undefined,
  timeoutMs: number = 3000,
): Promise<boolean> {
  const allowedOrigin = resolveAllowedOrigin(readSyncBaseUrl());
  if (!allowedOrigin || !baseUrl) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.origin !== allowedOrigin) {
    return false;
  }
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    await fetch(url, { method: "HEAD", signal: controller.signal, cache: "no-store" });
    return true;
  } catch {
    // Réseau absent, DNS, abort timeout, proxy... : jamais une exception.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
