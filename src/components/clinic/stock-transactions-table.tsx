"use client";

import { History } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Ligne d'historique telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `stockTransactions`) :
 * le contrat de sérialisation reste visible et vérifiable.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type StockTransactionTableRow = {
  id: string;
  type: string;
  qty: number;
  unitPrice: number | null;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
};

const typeLabels: Record<string, string> = {
  in: "Entrée",
  out: "Sortie",
  adjustment: "Ajustement",
};

const typeColors: Record<string, string> = {
  in: "bg-mint/10 text-mint",
  out: "bg-destructive/10 text-destructive",
  adjustment:
    "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre de
 * l'historique est imposé côté serveur (insertion chronologique) et un tri
 * « client » ne trierait que les lignes déjà chargées.
 */
const columns: ColumnDef<StockTransactionTableRow>[] = [
  {
    accessorKey: "type",
    header: "Type",
    enableSorting: false,
    cell: ({ row }) => (
      <span
        className={`inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium ${
          typeColors[row.original.type] || "bg-cool-100 text-muted-fg"
        }`}
      >
        {typeLabels[row.original.type] || row.original.type}
      </span>
    ),
  },
  {
    accessorKey: "qty",
    header: "Qté",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-medium text-foreground">{row.original.qty}</span>
    ),
  },
  {
    accessorKey: "unitPrice",
    header: "Prix unitaire",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.unitPrice ? formatCurrency(row.original.unitPrice) : "-",
  },
  {
    accessorKey: "reference",
    header: "Référence",
    enableSorting: false,
    cell: ({ row }) => row.original.reference || "-",
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
    accessorKey: "notes",
    header: "Notes",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-xs truncate">
        {row.original.notes || "-"}
      </span>
    ),
  },
];

export function StockTransactionsTable({
  data,
  className,
}: {
  data: StockTransactionTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      className={className}
      emptyIcon={History}
      emptyTitle="Aucun mouvement enregistré"
      emptyDescription="Les entrées et sorties de stock apparaîtront ici."
    />
  );
}
