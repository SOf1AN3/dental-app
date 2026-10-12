"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Ticket } from "lucide-react";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { updateTicketStatus } from "@/lib/actions/owner";
import { formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `support_ticket` (id, subject, status, priority, createdAt).
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 * `updateTicketStatus` est importée depuis le module `"use server"` dédié.
 */
export type SupportTicketTableRow = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: Date;
};

/**
 * État de chargement + état d'erreur du formulaire d'actions, isolé par ligne :
 * seul le ticket cliqué est verrouillé, les autres restent utilisables.
 */
function TicketActionsCell({ ticket }: { ticket: SupportTicketTableRow }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAction(status: "resolved" | "open"): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await updateTicketStatus(ticket.id, status);
      if ("error" in result && result.error) {
        setError(result.error);
      }
    } catch {
      setError("Erreur lors de la mise à jour du ticket");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        {ticket.status !== "resolved" && ticket.status !== "closed" ? (
          <form action={() => void runAction("resolved")}>
            <button
              type="submit"
              disabled={pending}
              className="text-sm font-medium text-mint hover:text-mint/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {pending ? "…" : "Résoudre"}
            </button>
          </form>
        ) : null}
        {ticket.status === "resolved" ? (
          <form action={() => void runAction("open")}>
            <button
              type="submit"
              disabled={pending}
              className="text-sm font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {pending ? "…" : "Rouvrir"}
            </button>
          </form>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * Les tickets sont ordonnés côté serveur (`getSupportTickets`) : un tri
 * « client » ne trierait que les lignes déjà chargées.
 */
const columns: ColumnDef<SupportTicketTableRow>[] = [
  {
    accessorKey: "subject",
    header: "Sujet",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-medium text-foreground">{row.original.subject}</span>
    ),
  },
  {
    accessorKey: "priority",
    header: "Priorité",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.priority} domain="ticketPriority" />
    ),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="ticket" />
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {formatDate(row.original.createdAt)}
      </span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => <TicketActionsCell ticket={row.original} />,
  },
];

export function SupportTicketTable({ data }: { data: SupportTicketTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Ticket}
      emptyTitle="Aucun ticket support"
      emptyDescription="Les tickets ouverts par les cliniques apparaîtront ici."
    />
  );
}
