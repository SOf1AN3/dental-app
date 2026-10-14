"use client";

/**
 * Tâche 7.2 — revue des DOUBLONS DE PATIENTS en attente (D-5).
 *
 * Pour chaque paire : dossier **existant** (canonique pressenti) vs
 * **doublon** (candidat) — nom, prénom et date de naissance **uniquement**
 * (aucune donnée médicale, aucune coordonnée). Deux actions :
 *  - « Fusionner » → `mergePatientAction` → `mergeDuplicatePatients` (le
 *    moteur peut **refuser** via ses garde-fous : le motif local est propagé
 *    dans un toast d'échec, jamais ignoré) ;
 *  - « Ignorer »   → `resolveMergeAction` → `resolveMerge` (clo la revue sans
 *    fusionner).
 *
 * La server action re-valide que les deux dossiers appartiennent au cabinet
 * actif (garde multi-tenant) avant toute écriture.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Users } from "lucide-react";

import {
  mergePatientAction,
  resolveMergeAction,
  type SyncMergeItem,
  type SyncMergeParty,
} from "@/lib/actions/sync";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

function formatBornAt(iso: string | null): string {
  if (iso === null) return "naissance inconnue";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "naissance inconnue";
  return `né(e) le ${format(at, "dd/MM/yyyy", { locale: fr })}`;
}

function partyLabel(party: SyncMergeParty | null): string {
  if (party === null) return "Dossier introuvable";
  return `${party.firstName} ${party.lastName} · ${formatBornAt(party.dateOfBirth)}`;
}

export function MergeReview({ merges }: { merges: readonly SyncMergeItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [actingId, setActingId] = useState<string | null>(null);

  const run = (id: string, task: () => Promise<{ success: boolean; message?: string; error?: string }>): void => {
    setActingId(id);
    startTransition(async () => {
      try {
        const result = await task();
        if (result.success) {
          toast.success(result.message ?? "Revue traitée.");
          router.refresh();
        } else {
          // Refus du moteur (garde-fous D-5) : le motif est propagé tel quel.
          toast.error(result.error ?? "Action impossible.");
        }
      } catch {
        toast.error("Action impossible (connexion au serveur local perdue).");
      } finally {
        setActingId(null);
      }
    });
  };

  if (merges.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Aucun doublon en attente"
        description="Les paires de patients refusées par les garde-fous de fusion apparaîtront ici pour revue."
        className="py-8"
      />
    );
  }

  return (
    <ul className="space-y-4">
      {merges.map((merge) => {
        const busy = isPending && actingId === merge.id;
        return (
          <li
            key={merge.id}
            className="rounded-lg border border-border-card bg-background p-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase text-muted-fg">Dossier existant</p>
                <p className="mt-1 text-sm text-foreground">{partyLabel(merge.existing)}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-fg">#{merge.canonicalId}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-muted-fg">Doublon pressenti</p>
                <p className="mt-1 text-sm text-foreground">{partyLabel(merge.candidate)}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-fg">#{merge.candidateId}</p>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-fg">Motif : {merge.reason}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                disabled={isPending}
                aria-busy={busy}
                onClick={() =>
                  run(merge.id, () =>
                    mergePatientAction({
                      candidateId: merge.candidateId,
                      existingId: merge.canonicalId,
                      reviewId: merge.id,
                    }),
                  )
                }
              >
                {busy ? "Fusion…" : "Fusionner"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={isPending}
                aria-busy={busy}
                onClick={() => run(merge.id, () => resolveMergeAction(merge.id))}
              >
                {busy ? "Traitement…" : "Ignorer"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
