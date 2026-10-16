/**
 * Tâche P3 — flux de connexion desktop : **logique pure** extraite de
 * l'ancien composant `FirstRunBootstrap` (supprimé en P3), puis orchestration
 * testable du repli vers le serveur central.
 *
 * ## Pourquoi ce module existe
 *
 * Une **installation neuve** de l'application de bureau possède une base
 * locale **vide** : aucun utilisateur → le login local (`bcrypt` sur `user`)
 * rejette toujours, même avec un compte valide. Les comptes viennent du
 * **serveur central**. Depuis la P3, l'utilisateur ne voit qu'**un seul**
 * bouton « Se connecter » : le repli est **invisible** pour lui.
 *
 * Le flux complet (page de connexion) est :
 *
 *  1. `signIn("credentials", …)` — chemin **local**, inchangé ;
 *  2. en cas d'erreur **et en mode desktop uniquement**
 *     (`useIsDesktop()` → faux = aucun appel ci-dessous) :
 *     a. `loginToSync(email, password)` — IPC vers le main Electron →
 *        `POST {central}/api/sync/token` : le main enregistre le jeton
 *        d'appareil, injecte `SYNC_TOKEN`/`SYNC_BASE_URL`/`DEVICE_ID` dans
 *        l'env de l'enfant Next et le **relance** ;
 *     b. `POST /api/sync/bootstrap` — route du serveur **local**, même
 *        origine que la page (jamais d'URL fournie par l'utilisateur),
 *        jamais mis en cache, délai plafonné : elle tire les données
 *        initiales (dont les hash d'accès) du central ;
 *     c. **nouveau** `signIn("credentials", …)` — un **seul** essai de repli,
 *        jamais de boucle (ce second essai ne redéclenche jamais (2)).
 *  3. en mode web : strictement le comportement d'origine (« Email ou mot de
 *     passe incorrect »), **aucun** IPC, **aucun** fetch bootstrap.
 *
 * ## Harness node-only (pourquoi des fonctions pures)
 *
 * `vitest.config.ts` configure un harness **node-only** :
 * `environment: "node"`, `include` limité aux fichiers `*.test.ts` sous
 * `src/` — aucun jsdom, aucun `@testing-library/react`. La décision est donc
 * extraite dans des fonctions **pures** —
 * {@link resolveBootstrapOutcome} (union fermée des issues de `loginToSync`),
 * {@link interpretBootstrapStatus} (statut HTTP du bootstrap) et
 * {@link attemptDesktopFallback} (enchaînement `loginToSync` → bootstrap →
 * retry, avec `loginToSync`/`fetchImpl`/`signIn` **injectés**, donc sans
 * React ni réseau réel) — testées dans
 * `src/lib/offline/bootstrap-flow.test.ts`.
 *
 * Aucun secret, aucun mot de passe ne circule dans l'UI ni dans les logs :
 * seuls des **messages rédigés** sont affichés (l'union fermée des motifs
 * d'échec est mappée exhaustivement, jamais de texte brut du serveur).
 */

import type { CentralLoginFailureReason, SyncLoginResult } from "@/hooks/use-desktop";

/* -------------------------------------------------------------------------- */
/* Messages (français, rédigés — jamais de texte brut du serveur central)      */
/* -------------------------------------------------------------------------- */

/**
 * Mapping **exhaustif** des motifs d'échec de `loginToSync` (union fermée
 * `CentralLoginFailureReason`, miroir du preload). Typé
 * `Record<CentralLoginFailureReason, string>` : l'ajout d'un motif dans
 * l'union fait **échouer la compilation** ici (clé manquante ou superflue) —
 * aucun repli muet possible, contrairement à un `switch` avec `default`.
 */
export const LOGIN_FAILURE_MESSAGES: Record<CentralLoginFailureReason, string> = {
  "no-central": "Aucun serveur central n'est configuré sur ce poste. Vérifiez la configuration de l'application.",
  "invalid-identifiers": "Email ou mot de passe invalide.",
  "invalid-credentials": "Email ou mot de passe incorrect.",
  "no-membership": "Ce compte n'est associé à aucun cabinet.",
  "device-bound-to-another-user":
    "Cet appareil est déjà lié à un autre compte. Contactez votre administrateur.",
  throttled: "Trop de tentatives de connexion. Patientez quelques minutes avant de réessayer.",
  "invalid-request": "Requête refusée par le serveur central. Vérifiez vos identifiants.",
  "central-error": "Le serveur central a rencontré une erreur. Réessayez plus tard.",
  "central-unreachable": "Le serveur central est injoignable. Vérifiez votre connexion Internet.",
  "storage-error": "Erreur de stockage local. Redémarrez l'application, puis réessayez.",
  "local-server-down":
    "Le serveur local de l'application est arrêté. Redémarrez l'application, puis réessayez.",
  "restart-timeout":
    "Le serveur local n'a pas redémarré à temps. Redémarrez l'application, puis réessayez.",
};

/** Repli honnête si le main omet le motif (l'union reste la source normative). */
export const GENERIC_LOGIN_FAILURE_MESSAGE =
  "La connexion au serveur central a échoué. Réessayez.";

/** Avertissement du main : env non appliqué, serveur local non relancé. */
export const SERVER_NOT_RESTARTED_MESSAGE =
  "Le serveur local n'a pas pu être relancé avec vos identifiants : " +
  "l'amorçage échouerait. Redémarrez l'application de bureau, puis reconnectez-vous.";

/** `ok: true` mais `clinicIds` absent (main plus ancien) : on n'improvise pas. */
export const INCOMPLETE_RESPONSE_MESSAGE =
  "Réponse incomplète du serveur central : la liste des cabinets est absente. " +
  "Mettez à jour l'application de bureau, puis réessayez.";

/** Compte rattaché à zéro cabinet : rien à tirer sur ce poste. */
export const NO_CLINICS_MESSAGE =
  "Aucun cabinet n'est associé à ce compte : il n'y a rien à récupérer sur ce poste. " +
  "Contactez votre administrateur.";

/** Champs du formulaire de connexion encore vides au moment du repli. */
export const FILL_FIELDS_MESSAGE =
  "Renseignez votre email et votre mot de passe dans le formulaire ci-dessus " +
  "avant de vous connecter.";

/** Pont Electron absent au moment du repli (démontage / preload refusé). */
export const BRIDGE_UNAVAILABLE_MESSAGE =
  "Le module de synchronisation de l'application est indisponible. " +
  "Redémarrez l'application, puis réessayez.";

/** 409 `not-authenticated` : la triade de jeton est absente du serveur local. */
export const BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE =
  "L'amorçage est indisponible : le serveur local ne détient pas encore les " +
  "identifiants du compte. Réessayez une fois la connexion effectuée.";

/** Tout autre statut non-2xx (400/500/…) — jamais de détail interne affiché. */
export const BOOTSTRAP_FAILED_MESSAGE =
  "L'amorçage a échoué. Réessayez, ou redémarrez l'application si le problème persiste.";

/** Réseau/timeout côté client : le serveur local n'a pas répondu. */
export const BOOTSTRAP_UNREACHABLE_MESSAGE =
  "Impossible de joindre le serveur local pour l'amorçage. " +
  "Vérifiez que l'application est ouverte, puis réessayez.";

/**
 * Succès de l'amorçage (2xx) : invitation explicite à cliquer sur
 * « Se connecter ». Depuis la P3 le retry automatique prend le relais, mais le
 * message reste l'ancrage sémantique du succès (testé tel quel).
 */
export const BOOTSTRAP_DONE_MESSAGE =
  "Compte récupéré : les données initiales ont été chargées. " +
  "Cliquez maintenant sur « Se connecter ».";

/**
 * Compte bien récupéré (bootstrap 2xx) mais le **second** `signIn` est refusé :
 * message explicite, jamais un « Email ou mot de passe incorrect » muet qui
 * laisserait croire que le compte n'existe toujours pas.
 */
export const RETRY_REFUSED_MESSAGE =
  "Votre compte a bien été récupéré sur ce poste, mais le mot de passe a été " +
  "refusé lors de la nouvelle tentative. Vérifiez votre mot de passe, puis réessayez.";

/* -------------------------------------------------------------------------- */
/* Décision pure — issue de `loginToSync` (testée sans React ni réseau)        */
/* -------------------------------------------------------------------------- */

/**
 * Verdict sur le résultat de `loginToSync`, en **fermé** : l'appelant ne peut
 * traiter que ces issues, sans repli muet.
 */
export type BootstrapOutcome =
  /** Identifiants centraux acceptés et cabinets connus → lancer le bootstrap. */
  | { readonly kind: "ready"; readonly clinicIds: readonly string[] }
  /** `ok: false` → motif mappé exhaustivement depuis l'union fermée. */
  | { readonly kind: "login-failed"; readonly message: string }
  /** `warning` `server-not-restartable`/`restart-failed` : l'amorçage échouerait. */
  | { readonly kind: "server-not-restarted"; readonly message: string }
  /** `ok: true` mais `clinicIds` non transmis : liste non devinable. */
  | { readonly kind: "incomplete-response"; readonly message: string }
  /** `clinicIds` vide : aucun cabinet rattaché au compte. */
  | { readonly kind: "no-clinics"; readonly message: string };

/**
 * Avertissements **connus** du main (le miroir les typent en `string` ouverte,
 * cf. `SyncLoginResult.warning`) : ces valeurs signifient que l'env n'a pas
 * été appliqué et que le serveur local tourne **sans** le jeton — le
 * `POST /api/sync/bootstrap` répondra 409. Un avertissement inconnu reste non
 * bloquant (l'appel bootstrap départagera, via son statut HTTP).
 */
export const SERVER_RESTART_WARNINGS: ReadonlySet<string> = new Set([
  "server-not-restartable",
  "restart-failed",
  // Même signification : le serveur local n'a jamais été relancé avec le jeton,
  // donc `POST /api/sync/bootstrap` renverra 409 — le remède est de redémarrer
  // l'application, pas de « réessayer une fois la connexion effectuée ».
  "env-unavailable",
  "env-rebuild-failed",
]);

/**
 * Décision pure sur le résultat de `loginToSync` — **aucun** accès réseau,
 * DOM ou horloge : testable dans le harness node-only du projet.
 *
 * Ordre des garde-fous (le plus actionable d'abord) :
 *  1. `!ok` → `login-failed` (message issu du mapping exhaustif de l'union) ;
 *  2. avertissement de redémarrage → `server-not-restarted` (honnête : ne pas
 *     faire faux espoir en lançant un bootstrap qui rejettera en 409) ;
 *  3. `clinicIds === undefined` → `incomplete-response` (liste **jamais**
 *     devinée) ;
 *  4. `clinicIds` vide → `no-clinics` ;
 *  5. sinon → `ready` avec la liste réelle.
 */
export function resolveBootstrapOutcome(result: SyncLoginResult): BootstrapOutcome {
  if (!result.ok) {
    return {
      kind: "login-failed",
      message:
        result.reason !== undefined
          ? LOGIN_FAILURE_MESSAGES[result.reason] ?? GENERIC_LOGIN_FAILURE_MESSAGE
          : GENERIC_LOGIN_FAILURE_MESSAGE,
    };
  }
  if (result.warning !== undefined && SERVER_RESTART_WARNINGS.has(result.warning)) {
    return { kind: "server-not-restarted", message: SERVER_NOT_RESTARTED_MESSAGE };
  }
  if (result.clinicIds === undefined) {
    return { kind: "incomplete-response", message: INCOMPLETE_RESPONSE_MESSAGE };
  }
  if (result.clinicIds.length === 0) {
    return { kind: "no-clinics", message: NO_CLINICS_MESSAGE };
  }
  return { kind: "ready", clinicIds: result.clinicIds };
}

/* -------------------------------------------------------------------------- */
/* Décision pure — statut HTTP du bootstrap (testée sans réseau)               */
/* -------------------------------------------------------------------------- */

/** Verdict sur la réponse du `POST /api/sync/bootstrap` local. */
export type BootstrapStatusOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "not-authenticated"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** Traduit le statut HTTP du bootstrap en issue fermée (aucun corps lu). */
export function interpretBootstrapStatus(status: number): BootstrapStatusOutcome {
  if (status >= 200 && status < 300) {
    return { kind: "done" };
  }
  if (status === 409) {
    return { kind: "not-authenticated", message: BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE };
  }
  return { kind: "failed", message: BOOTSTRAP_FAILED_MESSAGE };
}

/* -------------------------------------------------------------------------- */
/* Orchestration du repli desktop (deps injectées → testable sans réseau réel)  */
/* -------------------------------------------------------------------------- */

/** Délai maximal d'un appel au serveur local (échec fermé, jamais d'attente infinie). */
export const BOOTSTRAP_TIMEOUT_MS = 60_000;

/**
 * Sous-ensemble structurel de `fetch` consommé ici : accepte une URL relative
 * de même origine, renvoie la `Response`. Suffisant pour injecter un double
 * de test sans `any` ni cast.
 */
export interface BootstrapFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Sous-ensemble structurel de `SignInResponse` (next-auth, `redirect: false`)
 * : seule la présence d'une `error` est lue — le succès = absence d'erreur.
 */
export interface CredentialSignInResponse {
  readonly error?: string | undefined;
  readonly code?: string | undefined;
  readonly status?: number;
  readonly ok?: boolean;
  readonly url?: string | null;
}

/** Dépendances du repli, **injectées** (le module ne touche jamais `window`). */
export interface DesktopFallbackDeps {
  /** IPC vers le main Electron (`api.loginToSync`). */
  readonly loginToSync: (email: string, password: string) => Promise<SyncLoginResult>;
  /** Second essai de connexion **local** (next-auth, `redirect: false`). */
  readonly signIn: (email: string, password: string) => Promise<CredentialSignInResponse>;
  /** `fetch` du navigateur — injecté pour tester sans réseau réel. */
  readonly fetchImpl: BootstrapFetch;
}

/** Issue du repli desktop, en **fermé** (aucun repli muet dans la page). */
export type DesktopFallbackOutcome =
  /** Bootstrap 2xx puis second `signIn` **accepté** → `router.push(...)`. */
  | { readonly kind: "signed-in" }
  /** Bootstrap 2xx mais second `signIn` refusé (mot de passe) → message dédié. */
  | { readonly kind: "retry-refused"; readonly message: string }
  /** Échec à une étape (motifs rédigés, jamais de texte brut serveur). */
  | { readonly kind: "failed"; readonly message: string };

/**
 * Enchaîne `loginToSync` → `POST /api/sync/bootstrap` → **un seul** second
 * `signIn` — sans React, sans réseau réel (tout est injecté).
 *
 * Garde-fous :
 *  - identifiants vides → aucun appel, message inline ;
 *  - pont qui lève → {@link BRIDGE_UNAVAILABLE_MESSAGE} (jamais de crash) ;
 *  - échec d'une étape → `{ kind: "failed" }` **sans** jamais enchaîner les
 *    étapes suivantes (pas de boucle : seul ce module déclenche le repli, et
 *    il n'est appelé qu'une fois par soumission, avant le retry).
 */
export async function attemptDesktopFallback(
  email: string,
  password: string,
  deps: DesktopFallbackDeps,
): Promise<DesktopFallbackOutcome> {
  if (email.trim() === "" || password === "") {
    return { kind: "failed", message: FILL_FIELDS_MESSAGE };
  }

  // (1) Authentification centrale via le main Electron (IPC).
  let result: SyncLoginResult;
  try {
    result = await deps.loginToSync(email, password);
  } catch {
    return { kind: "failed", message: BRIDGE_UNAVAILABLE_MESSAGE };
  }

  // (2) Décision pure : motifs d'échec mappés, warnings honnêtes, listes
  //     jamais devinées.
  const outcome = resolveBootstrapOutcome(result);
  if (outcome.kind !== "ready") {
    return { kind: "failed", message: outcome.message };
  }

  // (3) Bootstrap : **même origine** que la page (aucune URL externe n'est
  //     acceptée de l'extérieur), jamais mis en cache, délai plafonné.
  try {
    const response = await deps.fetchImpl("/api/sync/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clinicIds: outcome.clinicIds }),
      cache: "no-store",
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
    const verdict = interpretBootstrapStatus(response.status);
    if (verdict.kind !== "done") {
      return { kind: "failed", message: verdict.message };
    }
  } catch {
    return { kind: "failed", message: BOOTSTRAP_UNREACHABLE_MESSAGE };
  }

  // (4) **Un seul** second essai de connexion local : c'est l'appelant (la
  //     page) qui décide du redirectionnement, et cet essai ne redéclenche
  //     jamais ce module (pas de boucle).
  const retry = await deps.signIn(email, password);
  if (retry.error !== undefined && retry.error !== null && retry.error !== "") {
    return { kind: "retry-refused", message: RETRY_REFUSED_MESSAGE };
  }
  return { kind: "signed-in" };
}
