/**
 * Tâche P2/P3 — tests de la logique de décision du flux de connexion desktop
 * (`src/lib/offline/bootstrap-flow.ts`, logique extraite de l'ancien composant
 * `FirstRunBootstrap` supprimé en P3).
 *
 * ## Pourquoi on teste des fonctions pures et non l'UI
 *
 * `vitest.config.ts` configure un harness **node-only** :
 * `environment: "node"`, `include` limité aux fichiers `*.test.ts` sous
 * `src/` — aucun jsdom, aucun
 * `@testing-library/react`, aucun test `.tsx` existant. Rendre l'UI de
 * connexion exigerait d'ajouter des dépendances et de reconfigurer le
 * harness, ce qui sort du cadre de la tâche. La décision est donc **extraite**
 * dans des fonctions pures exportées par le module :
 *
 *  - {@link resolveBootstrapOutcome} — verdict sur `SyncLoginResult`
 *    (motifs d'échec de l'union fermée, warnings de redémarrage, présence/
 *    vacuité de `clinicIds`) ;
 *  - {@link interpretBootstrapStatus} — verdict sur le statut HTTP du
 *    `POST /api/sync/bootstrap` ;
 *  - {@link attemptDesktopFallback} — enchaînement complet
 *    `loginToSync` → bootstrap → retry, avec les dépendances **injectées**
 *    (`loginToSync`/`fetchImpl`/`signIn`) : ni DOM, ni réseau réel, ni React.
 *
 * Ce qui est testé ici **est** la logique métier, sans DOM ni réseau.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DONE_MESSAGE,
  BOOTSTRAP_FAILED_MESSAGE,
  BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE,
  BOOTSTRAP_UNREACHABLE_MESSAGE,
  BRIDGE_UNAVAILABLE_MESSAGE,
  FILL_FIELDS_MESSAGE,
  GENERIC_LOGIN_FAILURE_MESSAGE,
  INCOMPLETE_RESPONSE_MESSAGE,
  LOGIN_FAILURE_MESSAGES,
  NO_CLINICS_MESSAGE,
  RETRY_REFUSED_MESSAGE,
  SERVER_NOT_RESTARTED_MESSAGE,
  attemptDesktopFallback,
  interpretBootstrapStatus,
  resolveBootstrapOutcome,
  type DesktopFallbackDeps,
  type DesktopFallbackOutcome,
} from "@/lib/offline/bootstrap-flow";
import type {
  CentralLoginFailureReason,
  SyncLoginResult,
} from "@/hooks/use-desktop";

// Module désormais absent du graphe (le flux n'utilise plus de toast) : le
// mock reste en place, inoffensif, pour ne pas reconfigurer le harness.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

/** Résultat `ok: true` minimal, surchargeable (jamais d'`any`). */
function okResult(overrides: Partial<SyncLoginResult> = {}): SyncLoginResult {
  return { ok: true, serverRestarted: true, ...overrides };
}

/** Liste attendue des motifs de l'union fermée (miroir du preload). */
const ALL_FAILURE_REASONS: readonly CentralLoginFailureReason[] = [
  "no-central",
  "invalid-identifiers",
  "invalid-credentials",
  "no-membership",
  "device-bound-to-another-user",
  "throttled",
  "invalid-request",
  "central-error",
  "central-unreachable",
  "storage-error",
  "local-server-down",
  "restart-timeout",
];

describe("LOGIN_FAILURE_MESSAGES — mapping exhaustif de l'union fermée", () => {
  it("couvre chaque motif d'échec avec un message français non vide", () => {
    for (const reason of ALL_FAILURE_REASONS) {
      const message = LOGIN_FAILURE_MESSAGES[reason];
      expect(message, `message manquant pour "${reason}"`).toBeTypeOf("string");
      expect(message.length, `message vide pour "${reason}"`).toBeGreaterThan(0);
      // Pas de valeur undefined silencieuse, jamais de texte brut typé "…".
      expect(message).not.toContain("undefined");
    }
  });

  it("ne porte jamais de secret (pas de mot de passe dans les messages)", () => {
    for (const reason of ALL_FAILURE_REASONS) {
      expect(LOGIN_FAILURE_MESSAGES[reason].toLowerCase()).not.toContain("mot de passe :");
    }
  });
});

describe("resolveBootstrapOutcome", () => {
  it("mappe chaque motif d'échec (ok: false) vers login-failed", () => {
    for (const reason of ALL_FAILURE_REASONS) {
      const outcome = resolveBootstrapOutcome({
        ok: false,
        reason,
        serverRestarted: false,
      });
      expect(outcome.kind, `issue inattendue pour "${reason}"`).toBe("login-failed");
      expect(outcome.kind === "login-failed" && outcome.message).toBe(
        LOGIN_FAILURE_MESSAGES[reason],
      );
    }
  });

  it("ok: false sans motif explicite → repli générique français", () => {
    const outcome = resolveBootstrapOutcome({ ok: false, serverRestarted: false });
    expect(outcome).toEqual({
      kind: "login-failed",
      message: GENERIC_LOGIN_FAILURE_MESSAGE,
    });
  });

  it("warning « server-not-restartable » → message honnête, sans appel suivant", () => {
    const outcome = resolveBootstrapOutcome(
      okResult({ warning: "server-not-restartable", serverRestarted: false, clinicIds: ["c1"] }),
    );
    expect(outcome).toEqual({
      kind: "server-not-restarted",
      message: SERVER_NOT_RESTARTED_MESSAGE,
    });
  });

  it("warning « restart-failed » → message honnête, sans appel suivant", () => {
    const outcome = resolveBootstrapOutcome(
      okResult({ warning: "restart-failed", serverRestarted: false, clinicIds: ["c1"] }),
    );
    expect(outcome).toEqual({
      kind: "server-not-restarted",
      message: SERVER_NOT_RESTARTED_MESSAGE,
    });
  });

  it("un avertissement inconnu reste non bloquant (le statut HTTP départagera)", () => {
    const outcome = resolveBootstrapOutcome(
      okResult({ warning: "something-else", clinicIds: ["c1"] }),
    );
    expect(outcome).toEqual({ kind: "ready", clinicIds: ["c1"] });
  });

  it("clinicIds absent (main plus ancien) → incomplete-response, liste jamais devinée", () => {
    const outcome = resolveBootstrapOutcome(okResult());
    expect(outcome).toEqual({
      kind: "incomplete-response",
      message: INCOMPLETE_RESPONSE_MESSAGE,
    });
  });

  it("clinicIds vide → no-clinics", () => {
    const outcome = resolveBootstrapOutcome(okResult({ clinicIds: [] }));
    expect(outcome).toEqual({ kind: "no-clinics", message: NO_CLINICS_MESSAGE });
  });

  it("clinicIds renseigné → ready avec la liste réelle (ordre préservé)", () => {
    const outcome = resolveBootstrapOutcome(okResult({ clinicIds: ["c2", "c1"] }));
    expect(outcome).toEqual({ kind: "ready", clinicIds: ["c2", "c1"] });
  });

  it("l'avertissement de redémarrage prime sur une liste absente (cause racine d'abord)", () => {
    const outcome = resolveBootstrapOutcome(
      okResult({ warning: "restart-failed", serverRestarted: false }),
    );
    expect(outcome.kind).toBe("server-not-restarted");
  });
});

describe("interpretBootstrapStatus", () => {
  it("2xx → done (bootstrap terminé)", () => {
    expect(interpretBootstrapStatus(200)).toEqual({ kind: "done" });
    expect(interpretBootstrapStatus(204)).toEqual({ kind: "done" });
  });

  it("409 → not-authenticated avec le message « connexion requise »", () => {
    expect(interpretBootstrapStatus(409)).toEqual({
      kind: "not-authenticated",
      message: BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE,
    });
  });

  it("tout autre statut → failed avec un message générique", () => {
    for (const status of [400, 401, 403, 404, 405, 500, 502, 504]) {
      expect(interpretBootstrapStatus(status)).toEqual({
        kind: "failed",
        message: BOOTSTRAP_FAILED_MESSAGE,
      });
    }
  });

  it("le message de succès invite explicitement à cliquer sur « Se connecter »", () => {
    expect(BOOTSTRAP_DONE_MESSAGE).toContain("Se connecter");
  });
});

/* -------------------------------------------------------------------------- */
/* Orchestration — `attemptDesktopFallback` (deps injectées, zéro réseau réel)  */
/* -------------------------------------------------------------------------- */

/** Appels enregistrés par le double de test (aucun `any`, aucun réseau). */
interface FallbackCalls {
  readonly loginToSync: Array<{ readonly email: string; readonly password: string }>;
  readonly fetch: Array<{
    readonly url: string;
    readonly init: RequestInit | undefined;
  }>;
  readonly signIn: Array<{ readonly email: string; readonly password: string }>;
}

interface FallbackHarness {
  readonly deps: DesktopFallbackDeps;
  readonly calls: FallbackCalls;
}

interface FallbackHarnessOptions {
  /** `SyncLoginResult` à renvoyer, ou `"throw"` (pont qui échoue). */
  readonly loginToSync?: SyncLoginResult | "throw";
  /** Statut HTTP du bootstrap, ou `"throw"` (serveur local injoignable). */
  readonly bootstrapStatus?: number | "throw";
  /** `error` du second `signIn` local (`undefined` = accepté). */
  readonly retryError?: string;
}

/**
 * Double de test : enregistre chaque appel et injecte des réponses
 * déterministes — la fonction sous test ne touche ni React, ni `window`, ni le
 * réseau réel.
 */
function createFallbackHarness(options: FallbackHarnessOptions = {}): FallbackHarness {
  const loginResult: SyncLoginResult | "throw" =
    options.loginToSync ?? { ok: true, serverRestarted: true, clinicIds: ["c1"] };
  const calls: FallbackCalls = {
    loginToSync: [],
    fetch: [],
    signIn: [],
  };
  const deps: DesktopFallbackDeps = {
    loginToSync: async (email, password): Promise<SyncLoginResult> => {
      calls.loginToSync.push({ email, password });
      if (loginResult === "throw") throw new Error("pont indisponible");
      return loginResult;
    },
    fetchImpl: async (url, init) => {
      calls.fetch.push({ url, init });
      if (options.bootstrapStatus === "throw") throw new Error("serveur local arrêté");
      return new Response(null, { status: options.bootstrapStatus ?? 200 });
    },
    signIn: async (email, password) => {
      calls.signIn.push({ email, password });
      return {
        error: options.retryError,
        code: undefined,
        status: options.retryError === undefined ? 200 : 401,
        ok: options.retryError === undefined,
        url: null,
      };
    },
  };
  return { deps, calls };
}

const FALLBACK_EMAIL = "patient@exemple.fr";
const FALLBACK_PASSWORD = "secret";

describe("attemptDesktopFallback", () => {
  it("identifiants vides → aucun appel, message de saisie", async () => {
    const harness = createFallbackHarness();
    const outcome = await attemptDesktopFallback("", FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: FILL_FIELDS_MESSAGE,
    });
    expect(harness.calls.loginToSync).toHaveLength(0);
    expect(harness.calls.fetch).toHaveLength(0);
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("pont Electron qui lève → BRIDGE_UNAVAILABLE_MESSAGE, aucune étape suivante", async () => {
    const harness = createFallbackHarness({ loginToSync: "throw" });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: BRIDGE_UNAVAILABLE_MESSAGE,
    });
    expect(harness.calls.fetch).toHaveLength(0);
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("loginToSync refusé → message de l'union fermée, ni bootstrap ni retry", async () => {
    const harness = createFallbackHarness({
      loginToSync: { ok: false, reason: "invalid-credentials", serverRestarted: false },
    });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: LOGIN_FAILURE_MESSAGES["invalid-credentials"],
    });
    expect(harness.calls.fetch).toHaveLength(0);
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("warning de redémarrage → message honnête, pas de bootstrap", async () => {
    const harness = createFallbackHarness({
      loginToSync: {
        ok: true,
        serverRestarted: false,
        warning: "server-not-restartable",
        clinicIds: ["c1"],
      },
    });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: SERVER_NOT_RESTARTED_MESSAGE,
    });
    expect(harness.calls.fetch).toHaveLength(0);
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("clinicIds absent → incomplete-response, liste jamais devinée", async () => {
    const harness = createFallbackHarness({
      loginToSync: { ok: true, serverRestarted: true },
    });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: INCOMPLETE_RESPONSE_MESSAGE,
    });
    expect(harness.calls.fetch).toHaveLength(0);
  });

  it("clinicIds vide → no-clinics (aucun cabinet), pas de bootstrap", async () => {
    const harness = createFallbackHarness({
      loginToSync: { ok: true, serverRestarted: true, clinicIds: [] },
    });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: NO_CLINICS_MESSAGE,
    });
    expect(harness.calls.fetch).toHaveLength(0);
  });

  it("bootstrap 200 → un seul second essai accepté → signed-in (même origine, no-store)", async () => {
    const harness = createFallbackHarness();
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);

    expect(outcome).toEqual<DesktopFallbackOutcome>({ kind: "signed-in" });
    expect(harness.calls.loginToSync).toHaveLength(1);
    expect(harness.calls.signIn).toHaveLength(1);
    expect(harness.calls.fetch).toHaveLength(1);

    const call = harness.calls.fetch[0];
    expect(call.url).toBe("/api/sync/bootstrap");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.cache).toBe("no-store");
    expect(call.init?.headers).toEqual({ "content-type": "application/json" });
    expect(call.init?.body).toBe(JSON.stringify({ clinicIds: ["c1"] }));
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);

    const retried = harness.calls.signIn[0];
    expect(retried).toEqual({ email: FALLBACK_EMAIL, password: FALLBACK_PASSWORD });
  });

  it("bootstrap 200 mais second signIn refusé → retry-refused, message explicite", async () => {
    const harness = createFallbackHarness({ retryError: "CredentialsSignin" });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "retry-refused",
      message: RETRY_REFUSED_MESSAGE,
    });
    expect(harness.calls.signIn).toHaveLength(1);
  });

  it("bootstrap 409 → not-authenticated, **aucun** second signIn", async () => {
    const harness = createFallbackHarness({ bootstrapStatus: 409 });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE,
    });
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("bootstrap 500 → échec rédigé, **aucun** second signIn (pas de boucle)", async () => {
    const harness = createFallbackHarness({ bootstrapStatus: 500 });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: BOOTSTRAP_FAILED_MESSAGE,
    });
    expect(harness.calls.loginToSync).toHaveLength(1);
    expect(harness.calls.signIn).toHaveLength(0);
  });

  it("fetch qui rejette → BOOTSTRAP_UNREACHABLE_MESSAGE, aucun second signIn", async () => {
    const harness = createFallbackHarness({ bootstrapStatus: "throw" });
    const outcome = await attemptDesktopFallback(FALLBACK_EMAIL, FALLBACK_PASSWORD, harness.deps);
    expect(outcome).toEqual<DesktopFallbackOutcome>({
      kind: "failed",
      message: BOOTSTRAP_UNREACHABLE_MESSAGE,
    });
    expect(harness.calls.signIn).toHaveLength(0);
  });
});
