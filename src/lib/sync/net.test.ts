import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_JITTER_RATIO,
  SyncScheduler,
  createBackoff,
  createCentralProbe,
} from "./net";
import type { Backoff } from "./net";

/**
 * Tests **hermétiques** (aucun réseau, aucune base, aucune horloge réelle) de
 * la détection réseau et de la politique de reprise — tâche 5.3.
 *
 * - le backoff est testé sans jitter (`jitterRatio: 0`) pour des valeurs
 *   exactes, puis avec injection `random` pour borner le jitter ±20 % ;
 * - `SyncScheduler` reçoit une horloge **injectée** : aucune dépendance à
 *   `Date.now()`, les assertions sont exactes au milliseconde ;
 * - `createCentralProbe` est un point de composition : on vérifie qu'il
 *   délègue bien (interface conforme) sans déclencher de réseau réel.
 */

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

describe("createBackoff", () => {
  it("sans jitter, produit 1000, 2000, 4000 … (index 0-based)", () => {
    const backoff = createBackoff({ jitterRatio: 0 });
    expect(backoff.nextDelayMs(0)).toBe(1_000);
    expect(backoff.nextDelayMs(1)).toBe(2_000);
    expect(backoff.nextDelayMs(2)).toBe(4_000);
    expect(backoff.nextDelayMs(3)).toBe(8_000);
    expect(backoff.nextDelayMs(4)).toBe(16_000);
  });

  it("plafonne à maxMs (5 min par défaut), même pour des attempts géants", () => {
    const backoff = createBackoff({ jitterRatio: 0 });
    // 2^9 = 512 → 512 000 ms > 300 000 : plafonné.
    expect(backoff.nextDelayMs(9)).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(backoff.nextDelayMs(10)).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(backoff.nextDelayMs(1_000)).toBe(DEFAULT_BACKOFF_MAX_MS);
    // Pas de NaN / Infinity par overflow de 2^attempt.
    expect(Number.isFinite(backoff.nextDelayMs(100_000))).toBe(true);
  });

  it("respects custom baseMs / maxMs", () => {
    const backoff = createBackoff({ baseMs: 250, maxMs: 1_000, jitterRatio: 0 });
    expect(backoff.nextDelayMs(0)).toBe(250);
    expect(backoff.nextDelayMs(1)).toBe(500);
    expect(backoff.nextDelayMs(2)).toBe(1_000);
    expect(backoff.nextDelayMs(7)).toBe(1_000);
  });

  it("borne le jitter dans ±jitterRatio (injection déterministe)", () => {
    const backoff = createBackoff(); // jitterRatio 0.2 par défaut
    // random() = 0 → facteur 0,8 ; random() = 1 → facteur 1,2 ; 0,5 → neutre.
    expect(backoff.nextDelayMs(0, () => 0)).toBe(800);
    expect(backoff.nextDelayMs(0, () => 0.5)).toBe(1_000);
    expect(backoff.nextDelayMs(0, () => 1)).toBe(1_200);
    expect(backoff.nextDelayMs(3, () => 0)).toBe(6_400);
    expect(backoff.nextDelayMs(3, () => 1)).toBe(9_600);
  });

  it("re-plafonne le résultat jitteré à maxMs (borne absolue)", () => {
    const backoff = createBackoff(); // maxMs 300 000
    expect(backoff.nextDelayMs(10, () => 1)).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(backoff.nextDelayMs(1_000, () => 1)).toBe(DEFAULT_BACKOFF_MAX_MS);
  });

  it("borne un random() hors bornes ou non fini", () => {
    const backoff = createBackoff();
    // -5 → borné à 0 (facteur 0,8) ; 7 → borné à 1 (facteur 1,2) ; NaN → neutre.
    expect(backoff.nextDelayMs(0, () => -5)).toBe(800);
    expect(backoff.nextDelayMs(0, () => 7)).toBe(1_200);
    expect(backoff.nextDelayMs(0, () => Number.NaN)).toBe(1_000);
  });

  it("mode étatuel : avance à chaque appel, reset() repart à 1 s", () => {
    const backoff = createBackoff({ jitterRatio: 0 });
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("un attempt explicite ne touche pas le compteur interne", () => {
    const backoff = createBackoff({ jitterRatio: 0 });
    expect(backoff.nextDelayMs(5)).toBe(32_000);
    // Le compteur interne est toujours à 0 : le prochain appel étatuel vaut 1 s.
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("rejette options et attempts invalides (erreurs de programmation)", () => {
    expect(() => createBackoff({ baseMs: 0 })).toThrow();
    expect(() => createBackoff({ baseMs: Number.NaN })).toThrow();
    expect(() => createBackoff({ maxMs: -1 })).toThrow();
    expect(() => createBackoff({ baseMs: 2_000, maxMs: 1_000 })).toThrow();
    expect(() => createBackoff({ jitterRatio: -0.1 })).toThrow();
    expect(() => createBackoff({ jitterRatio: 1.1 })).toThrow();
    const backoff = createBackoff();
    expect(() => backoff.nextDelayMs(-1)).toThrow();
    expect(() => backoff.nextDelayMs(1.5)).toThrow();
  });

  it("les défauts du plan sont bien 1 s / 5 min / ±20 %", () => {
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(1_000);
    expect(DEFAULT_BACKOFF_MAX_MS).toBe(5 * 60 * 1_000);
    expect(DEFAULT_JITTER_RATIO).toBe(0.2);
    const backoff = createBackoff({ jitterRatio: 0 });
    expect(backoff.nextDelayMs(0)).toBe(DEFAULT_BACKOFF_BASE_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* SyncScheduler                                                               */
/* -------------------------------------------------------------------------- */

/** Horloge contrôlable : jamais de `Date.now()` dans les tests. */
function createClock(startIso: string): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Backoff déterministe (sans jitter) pour des assertions exactes. */
function deterministicBackoff(): Backoff {
  return createBackoff({ jitterRatio: 0 });
}

describe("SyncScheduler", () => {
  const T0 = "2026-03-01T08:00:00.000Z";

  it("état initial : unknown, attempt 0, premier cycle immédiat", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });
    expect(scheduler.state).toBe("unknown");
    expect(scheduler.attempt).toBe(0);
    expect(scheduler.nextRunAt.toISOString()).toBe(T0);
    expect(scheduler.shouldRun()).toBe(true);
  });

  it("échecs successifs → nextRunAt croissant, séquence 1 s, 2 s, 4 s …", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });

    let previous = scheduler.nextRunAt.getTime();
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000];
    expectedDelays.forEach((expectedDelay, index) => {
      // L'orchestrateur retente à l'échéance : horloge avancée jusqu'à
      // `previous` avant chaque échec (sinon `now` reste figé à T0).
      clock.advance(previous - clock.now().getTime());
      const next = scheduler.registerFailure();
      expect(scheduler.state).toBe("offline");
      expect(scheduler.attempt).toBe(index + 1);
      // Croissant strictement.
      expect(next.getTime()).toBeGreaterThan(previous);
      // Écart exact = séquence de backoff.
      expect(next.getTime() - previous).toBe(expectedDelay);
      previous = next.getTime();
    });
  });

  it("nextRunAt est plafonné après assez d'échecs (5 min)", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });
    for (let i = 0; i < 20; i += 1) {
      scheduler.registerFailure();
      // L'orchestrateur attend l'échéance avant de retenter (horloge avance).
      clock.advance(scheduler.nextRunAt.getTime() - clock.now().getTime());
    }
    expect(scheduler.attempt).toBe(20);
    // Depuis l'état plafonné, chaque échec repousse d'exactement maxMs.
    const now = clock.now().getTime();
    const after = scheduler.registerFailure();
    expect(after.getTime() - now).toBe(DEFAULT_BACKOFF_MAX_MS);
  });

  it("shouldRun() refuse avant nextRunAt, autorise ensuite (horloge injectée)", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });
    scheduler.registerFailure(); // +1 s
    expect(scheduler.shouldRun()).toBe(false);
    clock.advance(999);
    expect(scheduler.shouldRun()).toBe(false);
    clock.advance(1);
    expect(scheduler.shouldRun()).toBe(true);
  });

  it("succès → remise à zéro : attempt 0, état online, cycle immédiat, backoff repart à 1 s", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });
    scheduler.registerFailure();
    scheduler.registerFailure();
    scheduler.registerFailure();
    expect(scheduler.attempt).toBe(3);

    clock.advance(5_000);
    const next = scheduler.registerSuccess();
    expect(scheduler.state).toBe("online");
    expect(scheduler.attempt).toBe(0);
    // Cycle immédiat : nextRunAt = l'horloge courante (jamais le futur).
    expect(next.getTime()).toBe(new Date(T0).getTime() + 5_000);
    expect(scheduler.shouldRun()).toBe(true);

    // Le backoff interne a bien été reset : le prochain échec repart de 1 s.
    const afterFailure = scheduler.registerFailure();
    expect(afterFailure.getTime() - next.getTime()).toBe(1_000);
  });

  it("nextRunAt expose une copie (non mutabile depuis l'extérieur)", () => {
    const clock = createClock(T0);
    const scheduler = new SyncScheduler({
      now: clock.now,
      backoff: deterministicBackoff(),
    });
    const snapshot = scheduler.nextRunAt;
    snapshot.setUTCFullYear(1999);
    expect(scheduler.nextRunAt.toISOString()).toBe(T0);
  });

  it("sans injection, utilise l'horloge réelle par défaut sans planter", () => {
    const scheduler = new SyncScheduler({ backoff: deterministicBackoff() });
    expect(scheduler.shouldRun()).toBe(true);
    const next = scheduler.registerFailure();
    expect(scheduler.state).toBe("offline");
    // nextRunAt repoussé dans le futur (1 s de backoff) par rapport au moment
    // de l'appel — on ne fige pas l'horloge ici, juste le sens de la flèche.
    expect(next.getTime()).toBeGreaterThan(Date.now() + 500);
    expect(scheduler.nextRunAt.getTime()).toBe(next.getTime());
  });
});

/* -------------------------------------------------------------------------- */
/* createCentralProbe (composition avec device-trust)                          */
/* -------------------------------------------------------------------------- */

describe("createCentralProbe", () => {
  it("délègue à isCentralReachable : env absente → false, sans lever", async () => {
    // Aucun SYNC_BASE_URL dans l'environnement de test (fail-closed) : le probe
    // doit renvoyer false sans aucun appel réseau.
    const probe = createCentralProbe();
    await expect(probe.probe(undefined)).resolves.toBe(false);
    await expect(
      probe.probe("https://central.example.com"),
    ).resolves.toBe(false);
  });

  it("respecte l'interface NetProbe (async, deux paramètres)", async () => {
    const probe = createCentralProbe();
    const result: unknown = await probe.probe(undefined, 1_500);
    expect(typeof result).toBe("boolean");
  });
});
