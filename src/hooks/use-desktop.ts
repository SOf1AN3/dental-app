"use client";

/**
 * Tâche 7.2 — accès typé et **défensif** au pont Electron `window.desktop`.
 *
 * ## Pourquoi un miroir typé local (et pas un import depuis `electron/`)
 *
 * Le `tsconfig.json` racine **exclut** `electron/` du programme TypeScript de
 * l'app web (`exclude: ["electron", "dist-electron"]`). Importer
 * `electron/preload.ts` depuis `src/` rattacherait tout le sous-arbre
 * (`electron/sync/auth.ts`, `electron/env.ts`, …) au programme Next, avec un
 * `moduleResolution` différent — source de fragilité pour `tsc --noEmit`.
 *
 * Ce fichier reproduit donc le **contrat du pont** (miroir structuré, commenté)
 * tel qu'exposé par `electron/preload.ts` via `contextBridge` :
 *  - `window.desktop` est **absent** dans un navigateur classique (`next dev`
 *    seul) → jamais de crash : {@link getDesktopApi} renvoie `null` ;
 *  - `SyncStatus` / `SyncLoginResult` sont les miroirs exacts des interfaces du
 *    preload ; `SyncCycleResult` est **importé depuis le cœur pur**
 *    (`@/lib/sync/runner-core`) — source unique, pas de duplication ;
 *  - `CentralLoginFailureReason` est l'**union fermée** de
 *    `electron/sync/auth.ts` : un `switch` exhaustif côté renderer n'a jamais
 *    de repli muet, et aucun message brut du serveur central n'y circule.
 *
 * Si le pont évolue, mettre à jour **ce miroir** en même temps que
 * `electron/preload.ts` (le contrat est volontairement minimal : seules les
 * méthodes consommées par l'UI de synchronisation sont reflétées).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
// Type seulement (jamais émis à l'exécution) : `SyncCycleResult` est le type de
// retour de `triggerSync()` — importé depuis le cœur pur, pas dupliqué.
import type { SyncCycleResult } from "@/lib/sync/runner-core";

// Re-export : le renderer consomme ce type via le hook (miroir du pont).
export type { SyncCycleResult };

/** Intervalle du **fallback polling** — desktop uniquement (jamais en web). */
export const SYNC_STATUS_POLL_INTERVAL_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* Miroir du contrat du pont (`electron/preload.ts`)                           */
/* -------------------------------------------------------------------------- */

/** Versions des composants de l'application (miroir de `AppVersions`). */
export interface AppVersions {
  app: string;
  electron: string;
  node: string;
}

/** Informations système (miroir de `AppInfo`). */
export interface AppInfo {
  platform: NodeJS.Platform;
  versions: AppVersions;
}

/**
 * État du runner de synchronisation (miroir de `SyncStatus`) :
 *  - `state` : `online`/`offline`/`unknown` (dernier probe) ou `inactive`
 *    (aucun runner : démarrage différé, échec de construction, arrêt) ;
 *  - `lastSyncAt` : ISO du dernier cycle **réussi** (`null` si aucun) ;
 *  - `pendingCount` : lignes `pending` de l'outbox local (`null` si base
 *    indisponible) ;
 *  - `lastError` : dernier motif d'erreur **rédigé** (`null` si aucun).
 */
export interface SyncStatus {
  state: "online" | "offline" | "unknown" | "inactive";
  lastSyncAt: string | null;
  pendingCount: number | null;
  lastError: string | null;
}

/**
 * Union **fermée** des motifs d'échec de `loginToSync` (miroir de
 * `electron/sync/auth.ts` — jamais de texte brut serveur côté renderer).
 */
export type CentralLoginFailureReason =
  | "no-central"
  | "invalid-identifiers"
  | "invalid-credentials"
  | "no-membership"
  | "device-bound-to-another-user"
  | "throttled"
  | "invalid-request"
  | "central-error"
  | "central-unreachable"
  | "storage-error"
  | "local-server-down"
  | "restart-timeout";

/** Résultat de `loginToSync(email, password)` (miroir de `SyncLoginResult`). */
export interface SyncLoginResult {
  readonly ok: boolean;
  readonly reason?: CentralLoginFailureReason;
  readonly message?: string;
  readonly serverRestarted: boolean;
  readonly warning?: string;
}

/** Canaux utilisés par l'UI de synchronisation (sous-ensemble de la allow-list). */
export interface DesktopEventMap {
  /** État réseau — signal de rafraîchissement (payload non consommé). */
  "net:state": unknown;
  /** État courant du runner (`getSyncStatus()`). */
  "sync:status": SyncStatus;
}

export type DesktopChannel = keyof DesktopEventMap;

/** Sous-ensemble consommé du pont `window.desktop` (cf. `electron/preload.ts`). */
export interface DesktopApi {
  readonly platform: NodeJS.Platform;
  readonly versions: AppVersions;
  readonly isDesktop: true;
  getInfo(): Promise<AppInfo>;
  getSyncStatus(): Promise<SyncStatus>;
  triggerSync(): Promise<SyncCycleResult>;
  loginToSync(email: string, password: string): Promise<SyncLoginResult>;
  onEvent<C extends DesktopChannel>(
    channel: C,
    cb: (payload: DesktopEventMap[C]) => void,
  ): () => void;
}

declare global {
  interface Window {
    /**
     * API Electron exposée par le preload.
     * `undefined` si la page est ouverte dans un navigateur classique.
     */
    readonly desktop?: DesktopApi;
  }
}

/* -------------------------------------------------------------------------- */
/* Accès défensif                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Lecture **défensive** du pont : `null` côté serveur (SSR) **et** dans un
 * navigateur classique. Jamais de crash, jamais d'`any`.
 */
export function getDesktopApi(): DesktopApi | null {
  if (typeof window === "undefined") return null;
  return window.desktop ?? null;
}

/** Abonnement sans effet : la présence du pont ne change pas pendant la vie d'une page. */
function subscribeDesktopPresence(onStoreChange: () => void): () => void {
  void onStoreChange;
  return () => {};
}

function getDesktopPresenceSnapshot(): boolean {
  return typeof window !== "undefined" && window.desktop !== undefined;
}

/**
 * `true` uniquement dans l'application de bureau. Lu via
 * `useSyncExternalStore` (système externe = le pont du preload) : SSR et
 * hydratation commencent sur `false` (serveur), sans divergence d'hydratation
 * ni `setState` dans un effet.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktopPresence,
    getDesktopPresenceSnapshot,
    () => false,
  );
}

/** Instantané du statut de synchronisation exposé aux composants d'UI. */
export interface SyncStatusSnapshot {
  /** `false` en web (aucun moteur de synchro) — l'UI doit alors se taire. */
  readonly isDesktop: boolean;
  /** `null` tant que le premier relevé n'est pas arrivé (ou en web). */
  readonly status: SyncStatus | null;
  /** Relevé immédiat (après un cycle déclenché, par exemple). */
  readonly refresh: () => void;
}

/**
 * État de synchronisation **desktop** :
 *  1. lecture initiale via `getSyncStatus()` ;
 *  2. abonnement à `net:state` (signal de rafraîchissement — le payload n'est
 *     pas consommé) ; le canal est **best-effort** : un preload plus ancien qui
 *     le refuserait laisserait le polling seul en charge ;
 *  3. **fallback polling** à {@link SYNC_STATUS_POLL_INTERVAL_MS}, **uniquement
 *     en desktop** : sans événement poussé par le main, le badge reste frais.
 *
 * Toute la logique est **défensive** : canal absent (`onEvent` lève), promesse
 * rejetée ou composant démonté — l'UI retombe sur `status: null`, sans crash.
 */
export function useSyncStatus(): SyncStatusSnapshot {
  const isDesktop = useIsDesktop();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    const api = getDesktopApi();
    if (api === null) return;
    api
      .getSyncStatus()
      .then((next) => {
        if (mountedRef.current) setStatus(next);
      })
      .catch(() => {
        // Relevé indisponible : on repasse en `null` plutôt qu'un statut périmé.
        if (mountedRef.current) setStatus(null);
      });
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      // Mode web : aucun timer, aucun abonnement, aucun bruit.
      return;
    }

    // Relevé initial + fallback polling (les `setState` ci-dessous sont
    // asynchrones — callbacks de promesse — jamais synchrones dans l'effet).
    refresh();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = getDesktopApi()?.onEvent("net:state", () => refresh()) ?? null;
    } catch {
      unsubscribe = null;
    }
    const timer = window.setInterval(refresh, SYNC_STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      if (unsubscribe !== null) unsubscribe();
    };
  }, [isDesktop, refresh]);

  // Démontage : les relevés en vol n'écrivent plus l'état.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { isDesktop, status, refresh };
}
