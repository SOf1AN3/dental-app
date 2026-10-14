"use client";

/**
 * Tâche 7.2 — liste des CONFLITS de synchronisation non résolus (D-4).
 *
 * Chaque ligne affiche le **strict nécessaire** de la revue : table, ligne
 * concernée (identifiant), motif rédigé et date d'arbitrage. Les payloads
 * `winning`/`losing` du journal ne sont **jamais** affichés (données de santé
 * potentielles).
 *
 * Le bouton « Marquer comme traité » délègue à la server action
 * `resolveConflictAction` (idempotente) puis rafraîchit la page ; succès et
 * échecs passent par `sonner`.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Inbox } from "lucide-react";

import { resolveConflictAction, type SyncConflictItem } from "@/lib/actions/sync";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";

/** Date courte et lisible (`12/01/2026 14:30`) — best-effort. */
function formatDecidedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return format(at, "dd/MM/yyyy HH:mm", { locale: fr });
}

export function ConflictList({ conflicts }: { conflicts: readonly SyncConflictItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const handleResolve = (id: string): void => {
    setResolvingId(id);
    startTransition(async () => {
      try {
        const result = await resolveConflictAction(id);
        if (result.success) {
          toast.success(result.message);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error("Action impossible (connexion au serveur local perdue).");
      } finally {
        setResolvingId(null);
      }
    });
  };

  if (conflicts.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Aucun conflit en attente"
        description="Les arbitrages remontés par le serveur central apparaîtront ici pour relecture."
        className="py-8"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ligne concernée</TableHead>
          <TableHead>Motif</TableHead>
          <TableHead>Arbitré le</TableHead>
          <TableHead>
            <span className="sr-only">Action</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {conflicts.map((conflict) => (
          <TableRow key={conflict.id}>
            <TableCell>
              <span className="font-medium text-foreground">{conflict.table}</span>
              <span className="ml-2 text-muted-fg">#{conflict.rowId}</span>
            </TableCell>
            <TableCell className="max-w-[24rem] truncate whitespace-normal">
              {conflict.reason ?? "Motif inconnu"}
            </TableCell>
            <TableCell className="text-muted-fg">{formatDecidedAt(conflict.decidedAt)}</TableCell>
            <TableCell className="text-right">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={isPending}
                aria-busy={isPending && resolvingId === conflict.id}
                onClick={() => handleResolve(conflict.id)}
              >
                {isPending && resolvingId === conflict.id
                  ? "Traitement…"
                  : "Marquer comme traité"}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
