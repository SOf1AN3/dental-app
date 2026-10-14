/**
 * Tâche 7.1 — acquisition du **jeton d'appareil** depuis le processus **main**
 * Electron (`POST {SYNC_BASE_URL}/api/sync/token`).
 *
 * Rôle dans le flux de bootstrap (installation neuve : base locale vide) :
 *  1. le renderer saisit email + mot de passe sur l'écran de login desktop ;
 *  2. le canal `sync:login` appelle {@link loginToCentral} — le mot de passe
 *     n'est **ni journalisé, ni persisté** côté main (il ne vit que le temps
 *     d'un message IPC et de cet échange HTTPS) ;
 *  3. le jeton est **persisté chiffré** (`writeSyncToken` → `config.json` via
 *     `safeStorage`/DPAPI), puis `main.ts` **redémarre l'enfant Next** avec
 *     l'env `SYNC_TOKEN` à jour (indispensable à la réservation de blocs de
 *     numéros, tâche 6.1c) ;
 *  4. l'enfant Next tire les données initiales (`POST /api/sync/bootstrap`),
 *     après quoi le poste fait son login **local** (bcrypt sur `user`).
 *
 * Discipline sécurité (NON NÉGOCIABLE) :
 *  - **jamais** de journal ni d'erreur ne contient le mot de passe, le jeton,
 *    le corps de requête ou de réponse — seules des raisons **génériques**
 *    sont propagées ({@link CentralLoginFailureReason}) et loguées ;
 *  - `AbortSignal.timeout(15_000)` : un central hors ligne ne bloque jamais
 *    l'UI au-delà de 15 s (échec fermé `central-unreachable`) ;
 *  - `SYNC_BASE_URL` absente **ou malformée** → échec fermé `no-central` :
 *    aucun appel vers une origine non configurée (anti-SSRF fail-closed) ;
 *  - `fetch` injectable ({@link LoginToCentralOptions}) pour les tests.
 *
 * ## Miroir de `resolveSyncBaseUrl()` (`electron/env.ts`, non exporté)
 *
 * La résolution est volontairement **identique** : `process.env.SYNC_BASE_URL`
 * d'abord, puis `.env`/`.env.local` **en dev uniquement** (même précédence
 * que `resolveDbConfig`/`resolveDevAuthSecret`). La validation est **refaite**
 * ici (schéma `http(s)` exigé) : `env.ts` n'est pas modifiable dans cette
 * tâche, et une valeur pourtant malformée ne doit jamais être utilisée.
 */

import log from 'electron-log'
import os from 'node:os'
import { z } from 'zod'
import { readDotEnvFile, resolveDeviceId, writeSyncToken } from '../env'

/** Délai maximum de l'échange — jamais d'attente infinie sur un central absent. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

/** Bornes des identifiants **avant** tout envoi (payload absurde = refus local). */
const EMAIL_MAX_LENGTH = 320
const PASSWORD_MAX_LENGTH = 1_024

/* -------------------------------------------------------------------------- */
/* Types publics                                                              */
/* -------------------------------------------------------------------------- */

export interface LoginToCentralParams {
  readonly email: string
  readonly password: string
}

export interface LoginToCentralOptions {
  /** `fetch` injecté (tests hermétiques) — défaut : `fetch` global du main. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Motifs **génériques** propagés au renderer et journalisés.
 *
 * La liste est fermée : aucune raison du serveur central hors de cette union
 * n'est jamais réexposée (pas d'oracle, pas d'écho de message serveur).
 *
 * ## Deux familles, une seule union (tâche 7.1c)
 *
 *  - les raisons **centrales** (échec de l'échange `POST /api/sync/token`) :
 *    déduites du statut/corps central ou locales à la saisie — seules ces
 *    raisons peuvent être dictées par le central, et {@link CENTRAL_REASONS}
 *    (liste blanche du corps `{ error }`) n'en contient **jamais** les deux
 *    suivantes ;
 *  - les raisons **postes** (`local-server-down`, `restart-timeout`) : l'échange
 *    a **réussi** (jeton persisté) mais l'application locale n'a pas pu appliquer
 *    la suite (relance de l'enfant Next). Elles vivent ici pour que le pont IPC
 *    (`preload.ts`) expose **une** union fermée au renderer, qui peut alors
 *    épuiser les cas (`switch` exhaustif) sans repli muet.
 */
export type CentralLoginFailureReason =
  /** `SYNC_BASE_URL` absente, illisible ou schéma non `http(s)`. */
  | 'no-central'
  /** Corps incomplet / mot de passe absent ou trop long. */
  | 'invalid-identifiers'
  /** 401 central : email/mot de passe refusés. */
  | 'invalid-credentials'
  /** 403 central : aucun cabinet actif rattaché au compte. */
  | 'no-membership'
  /** 403 central : `deviceId` déjà rattaché à un autre compte. */
  | 'device-bound-to-another-user'
  /** 429 central : limitation de débit. */
  | 'throttled'
  /** 400 central (ou corps invalide côté central). */
  | 'invalid-request'
  /** Réponse centrale inattendue (5xx, corps non conforme). */
  | 'central-error'
  /** Réseau/timeout : central injoignable. */
  | 'central-unreachable'
  /** Échec local (deviceId illisible, persistance du jeton impossible). */
  | 'storage-error'
  /**
   * **Poste** (tâche 7.1c) — échange réussi mais le serveur Next local n'a pas
   * pu être relancé **et aucun serveur ne répond** : le renderer est prévenu
   * qu'il n'a plus d'API locale. Jamais produit par le central.
   */
  | 'local-server-down'
  /**
   * **Poste** (tâche 7.1c) — échange réussi mais le redémarrage a dépassé le
   * budget de 30 s côté main : réponse bornée, filet de secours armé en
   * arrière-plan. Jamais produit par le central.
   */
  | 'restart-timeout'

export type LoginToCentralResult =
  | { readonly ok: true; readonly trustExpiresAt: string }
  | {
      readonly ok: false
      readonly reason: CentralLoginFailureReason
      readonly message: string
    }

/** Messages courts à afficher côté renderer — **aucun secret, aucun écho serveur**. */
const FAILURE_MESSAGES: Readonly<Record<CentralLoginFailureReason, string>> = {
  'no-central': 'Serveur central non configuré (SYNC_BASE_URL absente ou invalide).',
  'invalid-identifiers': 'Identifiants incomplets ou trop longs.',
  'invalid-credentials': 'Identifiants refusés par le serveur central.',
  'no-membership': 'Aucun cabinet actif rattaché à ce compte.',
  'device-bound-to-another-user': 'Cet appareil est déjà rattaché à un autre compte.',
  throttled: 'Trop de tentatives de connexion : réessayez dans quelques minutes.',
  'invalid-request': "Requête d'authentification refusée par le serveur central.",
  'central-error': 'Le serveur central a répondu de façon inattendue.',
  'central-unreachable': 'Serveur central injoignable (réseau ou délai dépassé).',
  'storage-error': 'Stockage local indisponible : le jeton n’a pas pu être conservé.',
  'local-server-down': 'Serveur local non redémarré — redémarrez l’application.',
  'restart-timeout':
    'Redémarrage du serveur local trop long (plus de 30 s) : redémarrez l’application.',
}

/**
 * Message court associé à une raison fermée — **source unique** consommée par
 * `main.ts` (tâche 7.1c) : le texte affiché au renderer et le texte testé par
 * le main ne peuvent pas diverger.
 */
export function centralLoginFailureMessage(reason: CentralLoginFailureReason): string {
  return FAILURE_MESSAGES[reason]
}

/** Raisons que le central est autorisé à nous dicter (corps `{ error }`).
 *
 * **Exclues volontairement** : `local-server-down` et `restart-timeout`
 * (pannes **poste**, jamais centrales) — un central qui prétendrait l'une de
 * ces valeurs serait remballée dans un repli `reasonFromStatus`, pas exécutée.
 */
const CENTRAL_REASONS: ReadonlySet<string> = new Set<CentralLoginFailureReason>([
  'invalid-credentials',
  'no-membership',
  'device-bound-to-another-user',
  'throttled',
  'invalid-request',
])

/* -------------------------------------------------------------------------- */
/* Schémas de réponse (Zod) — défense contre un corps central malformé         */
/* -------------------------------------------------------------------------- */

/** `200 { token, trustExpiresAt }` — miroir du contrat de `/api/sync/token`. */
const tokenResponseSchema = z.object({
  token: z.string().min(1).max(4096),
  trustExpiresAt: z.iso.datetime(),
})

/** Corps d'erreur central `{ error: "<raison>" }` (ignoré s'il diffère). */
const centralErrorSchema = z.object({ error: z.string().min(1).max(64) })

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function loginFailure(
  reason: CentralLoginFailureReason,
): Extract<LoginToCentralResult, { ok: false }> {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCentralReason(value: string): value is CentralLoginFailureReason {
  return CENTRAL_REASONS.has(value)
}

/**
 * Origine du central — **mirroir strict** de `resolveSyncBaseUrl()` de
 * `electron/env.ts` (fonction privée) : `process.env` d'abord, puis `.env`
 * en dev uniquement ; schéma `http(s)` exigé ; jamais d'écho de la valeur.
 */
function resolveCentralBaseUrl(): { url: string } | { error: string } {
  const fromProcess = process.env.SYNC_BASE_URL
  const raw =
    fromProcess !== undefined && fromProcess.trim() !== ''
      ? fromProcess.trim()
      : process.env.ELECTRON_DEV === '1'
        ? (readDotEnvFile()['SYNC_BASE_URL']?.trim() ?? '')
        : ''
  if (raw === '') {
    return { error: 'SYNC_BASE_URL absente : aucun serveur central configuré (mode hors-central).' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // Jamais la valeur brute en clair : elle pourrait porter des identifiants.
    return { error: 'SYNC_BASE_URL illisible : ce n’est pas une URL valide (http(s) attendu).' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `SYNC_BASE_URL invalide : schéma « ${parsed.protocol} » refusé (attendu http(s)).` }
  }
  // Un `/` final produisait `//api/sync/token` : normalisé ici, jamais ailleurs.
  return { url: raw.replace(/\/+$/, '') }
}

/** Traduit le statut HTTP d'un refus central en raison générique (fallback). */
function reasonFromStatus(status: number): CentralLoginFailureReason {
  if (status === 400) return 'invalid-request'
  if (status === 401) return 'invalid-credentials'
  if (status === 403) return 'no-membership'
  if (status === 429) return 'throttled'
  return 'central-error'
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Échange email + mot de passe contre un jeton d'appareil, puis **persiste**
 * ce jeton chiffré (`writeSyncToken`). **Ne lève jamais** : toute défaillance
 * est traduite en `{ ok: false, reason, message }` générique.
 *
 * @param params identifiants saisis par l'utilisateur (jamais journalisés).
 * @param options `fetch` injectable pour les tests.
 */
export async function loginToCentral(
  params: LoginToCentralParams,
  options: LoginToCentralOptions = {},
): Promise<LoginToCentralResult> {
  // (1) Bornes locales — aucun réseau pour un payload absurde, aucun journal
  //     de la valeur (un mot de passe ne figure dans aucun message).
  const email = params.email.trim()
  const password = params.password
  if (
    email === '' ||
    email.length > EMAIL_MAX_LENGTH ||
    password.length === 0 ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return loginFailure('invalid-identifiers')
  }

  // (2) Origine du central — échec fermé si absente/malformée.
  const central = resolveCentralBaseUrl()
  if ('error' in central) {
    log.warn(`[sync] échange d’identifiants impossible : ${central.error}`)
    return loginFailure('no-central')
  }

  // (3) Identifiant d'appareil persisté (`config.json`) — échec local fermé.
  let deviceId: string
  try {
    deviceId = resolveDeviceId()
  } catch (error) {
    log.error(`[sync] identifiant d’appareil illisible (${messageOf(error)})`)
    return loginFailure('storage-error')
  }

  // (4) Requête — timeout 15 s, corps jamais journalisé.
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${central.url}/api/sync/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        deviceId,
        deviceName: os.hostname(),
        os: process.platform,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // Seul le **nom** de l'erreur est journalisé : `message` pourrait reprendre
    // une URL, `cause` un fragment de requête.
    const name = error instanceof Error ? error.name : 'unknown'
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    log.warn(
      `[sync] échange d’identifiants impossible : ${
        timedOut ? `délai de ${TOKEN_REQUEST_TIMEOUT_MS} ms dépassé` : 'réseau indisponible'
      } (${name})`,
    )
    return loginFailure('central-unreachable')
  }

  // (5) Corps de la réponse — lu une fois, jamais journalisé.
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (response.status === 200) {
    const parsed = tokenResponseSchema.safeParse(body)
    if (!parsed.success) {
      log.warn('[sync] réponse du serveur central inattendue (jeton ou expiration absent)')
      return loginFailure('central-error')
    }
    try {
      // Chiffré `safeStorage` : le jeton ne transite jamais en clair sur disque.
      writeSyncToken(parsed.data.token, parsed.data.trustExpiresAt)
    } catch (error) {
      log.error(`[sync] persistance du jeton impossible (${messageOf(error)})`)
      return loginFailure('storage-error')
    }
    log.info('[sync] jeton d’appareil acquis et persisté chiffré (valeur jamais journalisée)')
    return { ok: true, trustExpiresAt: parsed.data.trustExpiresAt }
  }

  // (6) Refus — raison du corps si elle appartient à l'union fermée, sinon
  //     repli sur le statut HTTP. Aucun autre champ n'est retenu.
  const parsedError = centralErrorSchema.safeParse(body)
  const reason: CentralLoginFailureReason =
    parsedError.success && isCentralReason(parsedError.data.error)
      ? parsedError.data.error
      : reasonFromStatus(response.status)
  log.warn(`[sync] échange d’identifiants refusé : ${reason} (HTTP ${response.status})`)
  return loginFailure(reason)
}
