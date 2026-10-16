/**
 * Tâche P2 — tests de la logique de décision de l'amorçage « première
 * connexion » (`FirstRunBootstrap`).
 *
 * ## Pourquoi on teste des fonctions pures et non le composant
 *
 * `vitest.config.ts` configure un harness **node-only** :
 * `environment: "node"`, `include` limité aux fichiers `*.test.ts` sous
 * `src/` — aucun jsdom, aucun
 * `@testing-library/react`, aucun test `.tsx` existant. Rendre ce composant
 * exigerait d'ajouter des dépendances et de reconfigurer le harness, ce qui
 * sort du cadre de la tâche. La décision est donc **extraite** dans deux
 * fonctions pures exportées par le composant :
 *
 *  - {@link resolveBootstrapOutcome} — verdict sur `SyncLoginResult`
 *    (motifs d'échec de l'union fermée, warnings de redémarrage, présence/
 *    vacuité de `clinicIds`) ;
 *  - {@link interpretBootstrapStatus} — verdict sur le statut HTTP du
 *    `POST /api/sync/bootstrap`.
 *
 * Le composant se réduit alors à de la traduction événement → état React
 * (`setState`/`toast`), sans décision propre : ce qui est testé ici **est**
 * la logique métier, sans DOM ni réseau.
 *
 * `sonner` est mocké : le test n'attend aucune librairie de notification ni
 * aucun accès DOM au module niveau.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DONE_MESSAGE,
  BOOTSTRAP_FAILED_MESSAGE,
  BOOTSTRAP_NOT_AUTHENTICATED_MESSAGE,
  GENERIC_LOGIN_FAILURE_MESSAGE,
  INCOMPLETE_RESPONSE_MESSAGE,
  LOGIN_FAILURE_MESSAGES,
  NO_CLINICS_MESSAGE,
  SERVER_NOT_RESTARTED_MESSAGE,
  interpretBootstrapStatus,
  resolveBootstrapOutcome,
} from "@/components/offline/first-run-bootstrap";
import type {
  CentralLoginFailureReason,
  SyncLoginResult,
} from "@/hooks/use-desktop";

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
