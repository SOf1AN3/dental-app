/**
 * Tâche 5.3 — Détection réseau et politique de reprise de la synchronisation.
 *
 * Deux responsabilités, toutes deux **pures** (aucune I/O directe, zéro
 * `console`) pour rester testables hermétiquement (vitest, horloge et
 * `random` injectés — voir `net.test.ts`) :
 *
 *  1. **Détection** — `NetProbe` / `createCentralProbe()` : dit si le serveur
 *     central répond. Le probe par défaut **délègue** à `isCentralReachable`
 *     (`src/lib/offline/device-trust.ts`) : garde-fou SSRF fail-closed (origine
 *     strictement égale à celle de `SYNC_BASE_URL`, vérifiée **avant** tout
 *     appel réseau), timeout borné, jamais d'exception. **Aucune logique SSRF
 *     n'est dupliquée ici** : le « double niveau » est exactement celui déjà
 *     porté par `device-trust` — (1) validation de l'origine, (2) appel réseau
 *     borné qui ne lève jamais. L'interface `NetProbe` est **injectée** dans
 *     les tests (probe fake, aucun réseau réel).
 *
 *  2. **Reprise** — `createBackoff()` (exponentiel + jitter) et
 *     `SyncScheduler` (tentative, `nextRunAt`, remise à zéro sur succès) :
 *     l'orchestrateur (étapes 5.4/5.5) appelle `registerFailure()` après un
 *     cycle en échec et `registerSuccess()` après un cycle réussi, et
 *     n'entre en cycle que lorsque `shouldRun()` est vrai.
 *
 * ## Backoff — 1 s → 2 s → 4 s … plafonné à 5 min, jitter ±20 %
 *
 *  Le jitter (±20 % par défaut) décale aléatoirement chaque délai nominal :
 *  sans lui, tous les postes d'un cabinet qui se réveillent ensemble (retour
 *  de coupure réseau, redémarrage matinal) frapperaient le central au même
 *  milliseconde (« thundering herd »). `random` est injectable pour des tests
 *  déterministes.
 *
 *  Le plafond (5 min) porte sur le délai **nominal** ; le résultat effectif
 *  est en plus borné au-dessus par ce même plafond — le jitter ne peut donc
 *  raccourcir le délai au voisinage du plafond, jamais l'allonger au-delà.
 */

import { isCentralReachable } from "../offline/device-trust";

/* -------------------------------------------------------------------------- */
/* État de connectivité                                                       */
/* -------------------------------------------------------------------------- */

/**
 * État de connectivité vis-à-vis du serveur central :
 *  - `unknown`  — aucun cycle de détection exécuté encore (état initial) ;
 *  - `online`   — dernier probe/cycle réussi ;
 *  - `offline`  — dernier probe/cycle en échec (le backoff s'applique).
 */
export type OnlineState = "online" | "offline" | "unknown";

/* -------------------------------------------------------------------------- */
/* Détection (niveau 1)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sonde de disponibilité du serveur central. **Injectée** partout (jamais de
 * `fetch` en dur dans ce module) : les tests fournissent un probe fake, sans
 * réseau. `baseUrl === undefined` (aucun central configuré) doit renvoyer
 * `false` sans lever.
 */
export interface NetProbe {
  probe(baseUrl: string | undefined, timeoutMs?: number): Promise<boolean>;
}

/**
 * Probe de production : **délègue** à `isCentralReachable`
 * (`src/lib/offline/device-trust.ts`), qui porte déjà le double niveau —
 * (1) origine validée fail-closed contre `SYNC_BASE_URL` (SSRF), (2) appel
 * réseau `HEAD` à timeout borné qui ne lève jamais. Ce module n'ajoute ni ne
 * duplique aucune logique : il ne fait que respecter l'abstraction `NetProbe`
 * que l'orchestrateur injectera.
 */
export function createCentralProbe(): NetProbe {
  return {
    probe(baseUrl: string | undefined, timeoutMs?: number): Promise<boolean> {
      // `timeoutMs === undefined` → le défaut de `isCentralReachable` (3 s).
      return isCentralReachable(baseUrl, timeoutMs);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Backoff exponentiel avec jitter                                            */
/* -------------------------------------------------------------------------- */

/** Délai de la **première** reprise après un échec (1 s). */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** Plafond du délai nominal (5 min). */
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1_000;
/** Amplitude du jitter (±20 %) — évite le « thundering herd ». */
export const DEFAULT_JITTER_RATIO = 0.2;

export interface BackoffOptions {
  /** Délai de base (ms), strictement positif. Défaut : 1 000. */
  readonly baseMs?: number;
  /** Plafond du délai nominal (ms), ≥ `baseMs`. Défaut : 300 000 (5 min). */
  readonly maxMs?: number;
  /** Amplitude du jitter, dans [0 ; 1]. Défaut : 0,2 (±20 %). */
  readonly jitterRatio?: number;
}

export interface Backoff {
  /**
   * Délai (ms) à attendre après `attempt` échecs consécutifs (index **0-based** :
   * `0` → 1 s, `1` → 2 s, `2` → 4 s … plafonné à `maxMs`).
   *
   * - `attempt` **omis** : mode étatuel — le compteur interne est utilisé puis
   *   incrémenté (`reset()` le ramène à 0). C'est la forme « appelez et
   *   avancez ».
   * - `attempt` **fourni** : calcul pur pour cet index, le compteur interne
   *   n'est **pas** touché (l'orchestrateur possède son propre compteur).
   * - `random` : échantillon dans [0 ; 1] injectable pour des tests
   *   déterministes (défaut `Math.random` ; hors bornes → borné, non fini →
   *   neutre 0,5).
   *
   * Lève sur une option de construction ou un `attempt` invalide : ce sont des
   * erreurs de programmation, pas des conditions de course à absorber.
   */
  nextDelayMs(attempt?: number, random?: () => number): number;
  /** Ramène le compteur interne à 0 (prochain appel sans `attempt` → 1 s). */
  reset(): void;
}

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `sync/net : ${label} invalide (${value}) — nombre fini strictement positif attendu.`,
    );
  }
  return value;
}

function requireAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(
      `sync/net : attempt invalide (${attempt}) — entier ≥ 0 attendu.`,
    );
  }
  return attempt;
}

/**
 * Fabrique un backoff exponentiel avec jitter :
 * `min(baseMs * 2^attempt, maxMs)` puis jitter `±jitterRatio`, le tout re-plafonné
 * à `maxMs` (borne absolue, quelle que soit l'injection `random`).
 */
export function createBackoff(options: BackoffOptions = {}): Backoff {
  const baseMs = requirePositiveFinite(
    options.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    "baseMs",
  );
  const maxMs = requirePositiveFinite(
    options.maxMs ?? DEFAULT_BACKOFF_MAX_MS,
    "maxMs",
  );
  if (maxMs < baseMs) {
    throw new Error(
      `sync/net : maxMs (${maxMs}) doit être ≥ baseMs (${baseMs}).`,
    );
  }
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(
      `sync/net : jitterRatio invalide (${jitterRatio}) — nombre dans [0 ; 1] attendu.`,
    );
  }

  let internalAttempt = 0;

  const compute = (attempt: number, sample: number): number => {
    // `2 ** attempt` peut devenir `Infinity` (attempt très grand) : le `min`
    // final plafonne quoi qu'il arrive, sans NaN ni débordement.
    const nominal = Math.min(baseMs * 2 ** attempt, maxMs);
    const factor = 1 + jitterRatio * (2 * sample - 1);
    return Math.min(Math.max(Math.round(nominal * factor), 0), maxMs);
  };

  return {
    nextDelayMs(attempt?: number, random?: () => number): number {
      const rawSample = random === undefined ? Math.random() : random();
      // Hors bornes → borné ; NaN/Infinity → jitter neutre (0,5).
      const sample = Number.isFinite(rawSample)
        ? Math.min(Math.max(rawSample, 0), 1)
        : 0.5;
      if (attempt === undefined) {
        const current = internalAttempt;
        internalAttempt += 1;
        return compute(current, sample);
      }
      return compute(requireAttempt(attempt), sample);
    },
    reset(): void {
      internalAttempt = 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ordonnancement (niveau 2)                                                  */
/* -------------------------------------------------------------------------- */

export interface SyncSchedulerOptions {
  /** Horloge injectable (tests déterministes) — défaut : `() => new Date()`. */
  readonly now?: () => Date;
  /** Backoff injecté (séquence déterministe en tests) — défaut : ±20 %, 5 min. */
  readonly backoff?: Backoff;
}

/**
 * Ordonnanceur de cycles de synchronisation : suit le compteur d'échecs
 * consécutifs, calcule la date du prochain cycle (`nextRunAt`) via le backoff,
 * et se réinitialise sur succès. **Aucun `Date.now()` en dur** : l'horloge est
 * injectée (`now()`), ce qui rend les tests exacts au milliseconde.
 *
 * Usage orchestrateur (étapes 5.4/5.5) :
 * ```ts
 * const scheduler = new SyncScheduler({ now, backoff });
 * if (scheduler.shouldRun()) {
 *   const ok = await runCycle();
 *   if (ok) scheduler.registerSuccess(); else scheduler.registerFailure();
 * }
 * ```
 */
export class SyncScheduler {
  private readonly clock: () => Date;
  private readonly backoff: Backoff;
  private attemptCount = 0;
  private nextRun: Date;
  private onlineState: OnlineState = "unknown";

  constructor(options: SyncSchedulerOptions = {}) {
    this.clock = options.now ?? ((): Date => new Date());
    this.backoff = options.backoff ?? createBackoff();
    // Premier cycle immédiat : au démarrage, on tente une synchronisation sans
    // attendre (le backoff n'a de sens qu'après un échec).
    this.nextRun = this.clock();
  }

  /** Dernier état connu (`unknown` tant qu'aucun cycle n'a été enregistré). */
  get state(): OnlineState {
    return this.onlineState;
  }

  /** Nombre d'échecs consécutifs (remis à 0 par `registerSuccess`). */
  get attempt(): number {
    return this.attemptCount;
  }

  /** Date du prochain cycle autorisé (copie défensive : jamais mutabile depuis l'extérieur). */
  get nextRunAt(): Date {
    return new Date(this.nextRun.getTime());
  }

  /**
   * Un cycle est-il autorisé à `at` (défaut : l'horloge injectée) ? `true`
   * tant qu'aucun échec n'est enregistré (prochain cycle immédiat).
   */
  shouldRun(at?: Date): boolean {
    const reference = at ?? this.clock();
    return reference.getTime() >= this.nextRun.getTime();
  }

  /**
   * Enregistre un cycle en échec : compteur +1, état `offline`, prochain cycle
   * repoussé du délai de backoff (1 s, 2 s, 4 s … plafonné). Renvoie le
   * `nextRunAt` résultant.
   */
  registerFailure(): Date {
    this.attemptCount += 1;
    this.onlineState = "offline";
    // `attemptCount - 1` : le premier échec correspond à l'index 0 (1 s).
    const delayMs = this.backoff.nextDelayMs(this.attemptCount - 1);
    this.nextRun = new Date(this.clock().getTime() + delayMs);
    return new Date(this.nextRun.getTime());
  }

  /**
   * Enregistre un cycle réussi : compteur remis à 0 (le backoff repart de 1 s
   * au prochain échec), état `online`, prochain cycle immédiat. Renvoie le
   * `nextRunAt` résultant.
   */
  registerSuccess(): Date {
    this.attemptCount = 0;
    this.backoff.reset();
    this.onlineState = "online";
    this.nextRun = this.clock();
    return new Date(this.nextRun.getTime());
  }
}
