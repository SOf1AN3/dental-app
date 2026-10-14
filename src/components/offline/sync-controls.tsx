"use client";

/**
 * Tâche 7.2 — contrôles de synchronisation de `/settings/sync` (client).
 *
 * Regroupe, **en desktop uniquement** :
 *  - le détail de l'état (statut, dernière synchro, file d'attente, dernière
 *    erreur) dérivé de {@link describeSyncBadge} — une seule règle décrit
 *    l'état partout dans l'app ;
 *  - les informations d'appareil via `desktop.getInfo()` (nom de plateforme,
 *    versions) ;
 *  - « Synchroniser maintenant » (`triggerSync()`) — chaque branche de
 *    l'union fermée `SyncCycleResult` produit un toast explicite ;
 *  - « Se connecter au serveur » : formulaire email/mot de passe →
 *    `loginToSync()` (IPC) puis, au succès, `bootstrapAction([clinicId])`
 *    (server action → `POST /api/sync/bootstrap` en localhost). Les échecs
 *    sont mappés depuis l'**union fermée** `CentralLoginFailureReason` :
 *    jamais de texte brut du serveur central.
 *
 * En **web** (pas de `window.desktop`) : un paragraphe neutre Explique que la
 * synchronisation est réservée à l'application de bureau — aucun bouton IPC,
 * aucun crash. Le `<Toaster />` de `sonner` est monté ici (unique sur la page)
 * pour les toasts des listes de revue voisines.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeSyncBadge, formatRelativeSync } from "@/components/offline/sync-status";
import { bootstrapAction } from "@/lib/actions/sync";
import {
  getDesktopApi,
  useSyncStatus,
  type AppInfo,
  type CentralLoginFailureReason,
  type SyncCycleResult,
  type SyncLoginResult,
} from "@/hooks/use-desktop";

/** Messages des raisons **fermées** d'échec de connexion (jamais de texte central). */
const LOGIN_REASON_MESSAGES: Record<CentralLoginFailureReason, string> = {
  "no-central": "Aucun serveur central configuré sur cet appareil.",
  "invalid-identifiers": "Identifiants incomplets ou trop longs.",
  "invalid-credentials": "Email ou mot de passe refusé par le serveur central.",
  "no-membership": "Aucun cabinet actif n'est rattaché à ce compte.",
  "device-bound-to-another-user": "Cet appareil est déjà rattaché à un autre compte.",
  throttled: "Trop de tentatives : réessayez dans quelques instants.",
  "invalid-request": "Requête refusée par le serveur central.",
  "central-error": "Réponse inattendue du serveur central (réessayez plus tard).",
  "central-unreachable": "Serveur central injoignable (vérifiez le réseau).",
  "storage-error": "Enregistrement du jeton d'appareil impossible sur ce poste.",
  "local-server-down":
    "Connexion acceptée mais le serveur local ne répond plus : redémarrez l'application.",
  "restart-timeout":
    "Connexion acceptée mais le redémarrage du serveur local a dépassé le délai — l'application continue en arrière-plan.",
};

/** Traduit un résultat de cycle (`SyncCycleResult`, union fermée) en toast. */
function describeCycleResult(result: SyncCycleResult): {
  success: boolean;
  message: string;
} {
  switch (result.status) {
    case "pushed":
      return {
        success: result.rejected === 0,
        message:
          result.rejected === 0
            ? `Synchronisation poussée : ${result.accepted} opération(s) envoyée(s).`
            : `Poussée partielle : ${result.accepted} acceptée(s), ${result.rejected} refusée(s).`,
      };
    case "pulled":
      return {
        success: true,
        message: `Synchronisation réussie : ${result.applied} changement(s) reçu(s).`,
      };
    case "noop":
      return {
        success: true,
        message:
          result.reason === "concurrent-cycle"
            ? "Un cycle de synchronisation est déjà en cours."
            : "Rien à synchroniser pour l'instant.",
      };
    case "offline":
      return { success: false, message: "Hors-ligne : synchronisation reportée." };
    case "needs-auth":
      return {
        success: false,
        message: "Connexion requise : connectez-vous au serveur central ci-dessous.",
      };
    case "needs-clinic":
      return { success: false, message: "Aucun cabinet actif sélectionné." };
    case "idle-no-base-url":
      return { success: false, message: "Aucun serveur central configuré sur cet appareil." };
    case "error":
      return { success: false, message: `Échec de synchronisation : ${result.reason}` };
  }
}

/** Traduit un échec de login (`SyncLoginResult`) en toast + retour. */
function loginFailureMessage(result: SyncLoginResult): string {
  if (result.reason !== undefined) return LOGIN_REASON_MESSAGES[result.reason];
  return result.message ?? "Connexion au serveur central impossible.";
}

function SyncDeviceCard({ info }: { info: AppInfo }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
      <div className="flex gap-2">
        <dt className="text-muted-fg">Appareil :</dt>
        <dd className="font-medium text-foreground">{info.platform}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-fg">Application :</dt>
        <dd className="font-medium text-foreground">v{info.versions.app}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-fg">Electron :</dt>
        <dd className="font-medium text-foreground">{info.versions.electron}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-fg">Node.js :</dt>
        <dd className="font-medium text-foreground">{info.versions.node}</dd>
      </div>
    </dl>
  );
}

export function SyncControls({
  clinicId,
  pendingCount,
  failedCount,
}: {
  clinicId: string;
  pendingCount: number;
  failedCount: number;
}) {
  const { isDesktop, status, refresh } = useSyncStatus();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [isLoggingIn, startLoginTransition] = useTransition();
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);

  // Informations d'appareil — desktop uniquement, best-effort.
  useEffect(() => {
    let cancelled = false;
    if (isDesktop) {
      getDesktopApi()
        ?.getInfo()
        .then((appInfo) => {
          if (!cancelled) setInfo(appInfo);
        })
        .catch(() => {
          // Info non critique : la carte appareil reste masquée.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const handleSyncNow = (): void => {
    startSyncTransition(async () => {
      const api = getDesktopApi();
      if (api === null) return;
      try {
        const result = await api.triggerSync();
        const outcome = describeCycleResult(result);
        if (outcome.success) toast.success(outcome.message);
        else toast.error(outcome.message);
      } catch {
        toast.error("Synchronisation impossible (pont de bureau indisponible).");
      } finally {
        refresh();
      }
    });
  };

  const handleLogin = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    if (email.length === 0 || password.length === 0) {
      toast.error("Email et mot de passe requis.");
      return;
    }

    setBootstrapMessage(null);
    startLoginTransition(async () => {
      const api = getDesktopApi();
      if (api === null) return;
      try {
        const result = await api.loginToSync(email, password);
        if (!result.ok) {
          toast.error(loginFailureMessage(result));
          return;
        }
        if (result.warning !== undefined) {
          toast.warning(result.warning);
        }
        toast.success(
          result.serverRestarted
            ? "Connecté : jeton d'appareil acquis, serveur local relancé."
            : "Connecté : jeton d'appareil acquis.",
        );
        // Amorçage des données initiales du cabinet actif (server action).
        const bootstrap = await bootstrapAction([clinicId]);
        if (bootstrap.success) {
          setBootstrapMessage(
            bootstrap.hasMore
              ? `Amorçage partiel : ${bootstrap.pulled} opération(s) tirée(s) — relancez pour terminer.`
              : `Amorçage terminé : ${bootstrap.pulled} opération(s) tirée(s).`,
          );
        } else {
          setBootstrapMessage(bootstrap.error);
        }
        form.reset();
      } catch {
        toast.error("Connexion impossible (pont de bureau indisponible).");
      } finally {
        refresh();
      }
    });
  };

  // Mode WEB : état neutre, aucune donnée de desktop.
  if (!isDesktop) {
    return (
      <>
        <Toaster richColors position="top-right" />
        <p className="text-sm text-muted-fg">
          La synchronisation est disponible dans l&apos;application de bureau : le moteur
          local y pousse et tire les données vers le serveur central.
        </p>
      </>
    );
  }

  // Relevé encore `null` au premier rendu → `describeSyncBadge` rend l'état
  // `unknown` (« Statut indisponible », gris) : jamais un faux « Erreur » rouge.
  const descriptor = describeSyncBadge(status);
  const relative = formatRelativeSync(status?.lastSyncAt ?? null);

  return (
    <>
      <Toaster richColors position="top-right" />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${descriptor.dotClass}`} />
          <span className={`text-sm font-medium ${descriptor.textClass}`}>{descriptor.label}</span>
          <span className="text-sm text-muted-fg">— {descriptor.description}</span>
        </div>

        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-fg">Dernière synchronisation :</dt>
            <dd className="font-medium text-foreground">{relative ?? "jamais"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-fg">Opérations en attente :</dt>
            <dd className="font-medium text-foreground">{status?.pendingCount ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-fg">File locale (base) :</dt>
            <dd className="font-medium text-foreground">
              {pendingCount} en attente · {failedCount} en échec
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-fg">Dernière erreur :</dt>
            <dd className={status?.lastError ? "font-medium text-destructive" : "font-medium text-foreground"}>
              {status?.lastError ?? "aucune"}
            </dd>
          </div>
        </dl>

        {info !== null ? <SyncDeviceCard info={info} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={isSyncing}
            aria-busy={isSyncing}
            onClick={handleSyncNow}
          >
            {isSyncing ? "Synchronisation…" : "Synchroniser maintenant"}
          </Button>
        </div>

        <section className="rounded-lg border border-border-card bg-background p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            Connexion au serveur central
          </h3>
          <p className="mb-4 text-sm text-muted-fg">
            Échange email/mot de passe contre un jeton d&apos;appareil, puis amorçage des
            données initiales du cabinet actif.
          </p>
          <form onSubmit={handleLogin} className="max-w-md space-y-4">
            <div>
              <Label htmlFor="sync-email">Email</Label>
              <Input
                id="sync-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="sync-password">Mot de passe</Label>
              <Input
                id="sync-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="mt-1"
              />
            </div>
            <Button type="submit" variant="outline" disabled={isLoggingIn} aria-busy={isLoggingIn}>
              {isLoggingIn ? "Connexion…" : "Se connecter au serveur"}
            </Button>
          </form>
          {bootstrapMessage !== null ? (
            <p className="mt-3 text-sm text-foreground" role="status">
              {bootstrapMessage}
            </p>
          ) : null}
        </section>
      </div>
    </>
  );
}
