"use client";

/**
 * Tâche P2 — section « Première connexion sur ce poste ? » (application de
 * bureau uniquement).
 *
 * ## Pourquoi ce composant existe
 *
 * Une **installation neuve** de l'application de bureau possède une base
 * locale **vide** : aucun utilisateur → le login local (`bcrypt` sur `user`)
 * rejette toujours, même avec un compte valide. Les comptes viennent du
 * **serveur central** : il faut d'abord « récupérer le compte » sur le poste,
 * en deux temps :
 *
 *  1. `api.loginToSync(email, password)` — IPC vers le main Electron →
 *     `POST {central}/api/sync/token` : le main enregistre le jeton
 *     d'appareil, injecte `SYNC_TOKEN`/`SYNC_BASE_URL`/`DEVICE_ID` dans
 *     l'env de l'enfant Next et le **relance** ;
 *  2. `POST /api/sync/bootstrap` — route du serveur **local**, même origine
 *     que la page (jamais d'URL fournie par l'utilisateur) : elle tire les
 *     données initiales (dont les hash d'accès) du central et les applique
 *     localement. Le poste peut ensuite faire son login **local**.
 *
 * ## Réutilisation du formulaire de connexion
 *
 * Ce composant n'a **pas** son propre formulaire : il relit les valeurs déjà
 * saisies dans les champs `#email` / `#password` de la page de login via les
 * `RefObject` reçus en props — un seul couple identifiants, jamais de double
 * saisie divergente. Champs vides → message inline, aucun appel réseau.
 *
 * ## Mode desktop uniquement
 *
 * Rendu **uniquement** quand le pont `window.desktop` existe
 * ({@link useIsDesktop}) : `null` en web, **zéro** changement visible côté
 * navigateur. Le snapshot serveur du hook vaut `false` → le bloc n'apparaît
 * qu'après hydratation dans l'environnement Electron (sans divergence
 * d'hydratation, cf. le hook).
 *
 * ## Logique de décision pure (testée sans React ni réseau)
 *
 * Le harness de tests du projet est **node-only** (`vitest.config.ts` :
 * `environment: "node"`, `include` limité aux fichiers `*.test.ts` sous
 * `src/` — aucun `@testing-library/react`,
 * aucun jsdom). La décision est donc extraite dans des fonctions **pures** —
 * {@link resolveBootstrapOutcome} (union fermée des issues de
 * `loginToSync`) et {@link interpretBootstrapStatus} (statut HTTP du
 * bootstrap) — testées dans
 * `src/lib/offline/first-run-bootstrap.test.ts`, et le composant ne fait que
 * de la traduction événement → état React.
 *
 * Aucun secret, aucun mot de passe ne circule dans l'UI ni dans les logs :
 * seuls des **messages rédigés** sont affichés (l'union fermée des motifs
 * d'échec est mappée exhaustivement, jamais de texte brut du serveur).
 */

import { useState, type RefObject } from "react";
import { toast } from "sonner";
import {
  getDesktopApi,
  useIsDesktop,
  type CentralLoginFailureReason,
  type SyncLoginResult,
} from "@/hooks/use-desktop";

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

/** Repli honnête si le main omet le motif (l'union reste la source normale). */
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

/** Champs du formulaire de connexion encore vides au clic. */
export const FILL_FIELDS_MESSAGE =
  "Renseignez votre email et votre mot de passe dans le formulaire ci-dessus " +
  "avant de récupérer votre compte.";

/** Pont Electron absent au moment du clic (démontage / préload refusé). */
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

/** Succès : invitation explicite à cliquer sur « Se connecter ». */
export const BOOTSTRAP_DONE_MESSAGE =
  "Compte récupéré : les données initiales ont été chargées. " +
  "Cliquez maintenant sur « Se connecter ».";

/* -------------------------------------------------------------------------- */
/* Décision pure — issue de `loginToSync` (testée sans React ni réseau)        */
/* -------------------------------------------------------------------------- */

/**
 * Verdict sur le résultat de `loginToSync`, en **fermé** : le composant ne
 * peut traiter que ces issues, sans repli muet.
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
 * cf. `SyncLoginResult.warning`) : ces deux valeurs signifient que l'env n'a
 * pas été appliqué et que le serveur local tourne **sans** le jeton — le
 * `POST /api/sync/bootstrap` répondra 409. Un avertissement inconnu reste non
 * bloquant (l'appel bootstrap départagera, via son statut HTTP).
 */
const SERVER_RESTART_WARNINGS: ReadonlySet<string> = new Set([
  "server-not-restartable",
  "restart-failed",
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
          ? LOGIN_FAILURE_MESSAGES[result.reason]
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
/* Composant                                                                   */
/* -------------------------------------------------------------------------- */

/** Phase du flux d'amorçage (`done` = bootstrap terminé avec succès). */
type BootstrapPhase = "idle" | "submitting" | "done";

/** Retour d'information inline (accessible via `role="status"`). */
interface BootstrapFeedback {
  readonly kind: "error" | "success";
  readonly message: string;
}

export interface FirstRunBootstrapProps {
  /** Champ `#email` du formulaire de connexion (lecture seule, jamais de copie). */
  readonly emailRef: RefObject<HTMLInputElement | null>;
  /** Champ `#password` du formulaire de connexion (lecture au clic uniquement). */
  readonly passwordRef: RefObject<HTMLInputElement | null>;
}

/** Délai maximal d'un appel au serveur local (échec fermé, jamais d'attente infinie). */
const BOOTSTRAP_TIMEOUT_MS = 60_000;

export function FirstRunBootstrap({ emailRef, passwordRef }: FirstRunBootstrapProps) {
  const isDesktop = useIsDesktop();
  const [phase, setPhase] = useState<BootstrapPhase>("idle");
  const [feedback, setFeedback] = useState<BootstrapFeedback | null>(null);

  // Rendu desktop **uniquement** : en web, zéro changement. Placé après les
  // hooks (règles des hooks : aucun appel conditionnel).
  if (!isDesktop) return null;

  async function handleBootstrap(): Promise<void> {
    // (1) Relecture des identifiants **déjà saisis** dans le formulaire de
    //     connexion — jamais de second formulaire.
    const email = emailRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    if (email === "" || password === "") {
      setFeedback({ kind: "error", message: FILL_FIELDS_MESSAGE });
      return;
    }
    const api = getDesktopApi();
    if (api === null) {
      setFeedback({ kind: "error", message: BRIDGE_UNAVAILABLE_MESSAGE });
      return;
    }

    setPhase("submitting");
    setFeedback(null);

    // (2) Authentification centrale via le main Electron (IPC).
    let result: SyncLoginResult;
    try {
      result = await api.loginToSync(email, password);
    } catch {
      setPhase("idle");
      setFeedback({ kind: "error", message: BRIDGE_UNAVAILABLE_MESSAGE });
      return;
    }

    // (3) Décision pure : motifs d'échec mappés, warnings honnêtes, listes
    //     jamais devinées.
    const outcome = resolveBootstrapOutcome(result);
    if (outcome.kind !== "ready") {
      setPhase("idle");
      setFeedback({ kind: "error", message: outcome.message });
      toast.error(outcome.message);
      return;
    }

    // (4) Bootstrap : **même origine** que la page (aucune URL externe n'est
    //     acceptée de l'extérieur), jamais mis en cache, délai plafonné.
    try {
      const response = await fetch("/api/sync/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clinicIds: outcome.clinicIds }),
        cache: "no-store",
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });
      const verdict = interpretBootstrapStatus(response.status);
      if (verdict.kind === "done") {
        setPhase("done");
        setFeedback({ kind: "success", message: BOOTSTRAP_DONE_MESSAGE });
        toast.success(BOOTSTRAP_DONE_MESSAGE);
        return;
      }
      setPhase("idle");
      setFeedback({ kind: "error", message: verdict.message });
      toast.error(verdict.message);
    } catch {
      setPhase("idle");
      setFeedback({ kind: "error", message: BOOTSTRAP_UNREACHABLE_MESSAGE });
      toast.error(BOOTSTRAP_UNREACHABLE_MESSAGE);
    }
  }

  return (
    <section
      aria-labelledby="first-run-bootstrap-title"
      className="rounded-lg border border-dashed border-input p-4 text-left"
    >
      <h3 id="first-run-bootstrap-title" className="text-sm font-semibold text-foreground">
        Première connexion sur ce poste&nbsp;?
      </h3>
      <p className="mt-1 text-sm text-muted-fg">
        Une installation neuve possède une base locale vide&nbsp;: ce poste doit d&apos;abord
        récupérer votre compte auprès du serveur central avant de pouvoir se connecter.
        Saisissez vos identifiants dans le formulaire ci-dessus, puis lancez la
        récupération.
      </p>

      <button
        type="button"
        onClick={() => void handleBootstrap()}
        disabled={phase === "submitting"}
        aria-busy={phase === "submitting"}
        className="mt-3 w-full rounded-lg border border-input bg-transparent px-4 py-2.5 text-sm font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {phase === "submitting" ? "Récupération en cours…" : "Récupérer mon compte"}
      </button>

      {feedback !== null && (
        <div
          role="status"
          aria-live="polite"
          className={
            feedback.kind === "error"
              ? "mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              : "mt-3 rounded-lg bg-primary/10 p-3 text-sm text-foreground"
          }
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
