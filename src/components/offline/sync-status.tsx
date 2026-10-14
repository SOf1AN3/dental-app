"use client";

/**
 * Tâche 7.2 — INDICATEUR DE SYNCHRONISATION (badge d'en-tête).
 *
 * Rendu **uniquement** en mode desktop : sans `window.desktop`, l'app web n'a
 * pas de moteur de synchro et ce composant ne rend **rien** (le layout web est
 * donc strictement inchangé).
 *
 * États dérivés de `SyncStatus` (miroir du pont) :
 *  - `Erreur`           — un dernier motif d'erreur est renseigné (rouge) ;
 *  - `Hors-ligne`       — le probe réseau échoue (gris) ;
 *  - `Connexion requise`— runner inactif : poste non connecté / non démarré
 *                         (bleu) — actionnable : ouvre `/settings/sync` ;
 *  - `En attente (n)`   — opérations dans l'outbox local (ambre) ;
 *  - `Synchronisé`      — en ligne, file vide ; l'heure relative du dernier
 *                         cycle réussie est portée par le `title` et l'`aria-label`
 *                         (vert) ;
 *  - `Statut indisponible` — état `unknown` ou relevé null (gris).
 *
 * Accessibilité : le badge est un `<button>` avec `aria-label` explicite
 * (état complet + action), focus clavier visible (variants `ui/button`), et
 * contraste respecté (pastille foncée + libellé `*-fg` sur fond transparent).
 */

import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { useSyncStatus, type SyncStatus } from "@/hooks/use-desktop";

/** Catégorie visuelle dérivée de l'état de synchro. */
export type SyncBadgeKind =
  | "synced"
  | "pending"
  | "offline"
  | "needs-login"
  | "error"
  | "unknown";

export interface SyncBadgeDescriptor {
  kind: SyncBadgeKind;
  /** Libellé court affiché dans le badge. */
  label: string;
  /** Classe de la pastille (puce colorée). */
  dotClass: string;
  /** Classe du libellé (contraste sur fond carte). */
  textClass: string;
  /** Description longue pour `aria-label` / `title`. */
  description: string;
}

/** Heure relative du dernier cycle réussi (`il y a 5 minutes`) — best-effort. */
export function formatRelativeSync(iso: string | null): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return formatDistanceToNow(at, { locale: fr, addSuffix: true });
}

/**
 * Dérivation **pure** de l'affichage à partir du statut — partagée avec
 * `/settings/sync` (panneau de détail) pour qu'une seule règle décide de l'état.
 */
export function describeSyncBadge(status: SyncStatus | null): SyncBadgeDescriptor {
  if (status === null || status.lastError !== null) {
    return {
      kind: "error",
      label: "Erreur",
      dotClass: "bg-danger",
      textClass: "text-danger",
      description:
        status === null
          ? "Statut de synchronisation indisponible"
          : `Dernière erreur : ${status.lastError}`,
    };
  }
  switch (status.state) {
    case "offline":
      return {
        kind: "offline",
        label: "Hors-ligne",
        dotClass: "bg-cool-500",
        textClass: "text-muted-fg",
        description: "Pas de connexion au serveur central",
      };
    case "inactive":
      return {
        kind: "needs-login",
        label: "Connexion requise",
        dotClass: "bg-cerulean",
        textClass: "text-cerulean",
        description:
          "Moteur de synchronisation inactif : connectez-vous au serveur central",
      };
    case "unknown":
      return {
        kind: "unknown",
        label: "Statut indisponible",
        dotClass: "bg-cool-500",
        textClass: "text-muted-fg",
        description: "État de synchronisation non encore connu",
      };
    case "online": {
      if (status.pendingCount !== null && status.pendingCount > 0) {
        return {
          kind: "pending",
          label: `En attente (${status.pendingCount})`,
          dotClass: "bg-amber",
          textClass: "text-amber-fg",
          description: `${status.pendingCount} opération(s) en attente de synchronisation`,
        };
      }
      const relative = formatRelativeSync(status.lastSyncAt);
      return {
        kind: "synced",
        label: "Synchronisé",
        dotClass: "bg-mint",
        textClass: "text-mint",
        description:
          relative === null
            ? "À jour — aucune synchronisation réussie pour l'instant"
            : `À jour — dernière synchronisation ${relative}`,
      };
    }
  }
}

/**
 * Badge compact, cliquable → `/settings/sync`.
 * Rend `null` en mode web ou tant que le premier relevé n'est pas arrivé
 * (aucun clignotement au chargement, aucun layout shift côté web).
 */
export function SyncStatus() {
  const router = useRouter();
  const { isDesktop, status } = useSyncStatus();

  if (!isDesktop || status === null) return null;

  const descriptor = describeSyncBadge(status);
  const relative = formatRelativeSync(status.lastSyncAt);

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => router.push("/settings/sync")}
      aria-label={`Synchronisation : ${descriptor.label} — ${descriptor.description}. Ouvrir les paramètres de synchronisation.`}
      title={
        relative === null
          ? descriptor.description
          : `${descriptor.description} (dernière synchro ${relative})`
      }
      className="gap-2"
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${descriptor.dotClass}`} />
      <span className={descriptor.textClass}>{descriptor.label}</span>
    </Button>
  );
}
