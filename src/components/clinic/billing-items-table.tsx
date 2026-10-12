"use client";

import { FileText } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { formatCurrency } from "@/lib/utils";

/**
 * Ligne de document de facturation (facture OU devis — les deux tables ont la
 * même structure) telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `invoiceItems` /
 * `quoteItems`) : le contrat de sérialisation reste visible et vérifiable.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type BillingItemTableRow = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number | null;
  discount: number | null;
  total: number;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre des
 * lignes est celui de la saisie, imposé côté serveur.
 */
const columns: ColumnDef<BillingItemTableRow>[] = [
  {
    accessorKey: "description",
    header: "Description",
    enableSorting: false,
    cell: ({ row }) => <span className="text-foreground">{row.original.description}</span>,
  },
  {
    accessorKey: "quantity",
    header: "Qté",
    enableSorting: false,
  },
  {
    accessorKey: "unitPrice",
    header: "Prix unitaire",
    enableSorting: false,
    cell: ({ row }) => formatCurrency(row.original.unitPrice),
  },
  {
    accessorKey: "taxRate",
    header: "TVA",
    enableSorting: false,
    cell: ({ row }) =>
      (row.original.taxRate ?? 0) > 0 ? `${row.original.taxRate}%` : "-",
  },
  {
    accessorKey: "discount",
    header: "Remise",
    enableSorting: false,
    cell: ({ row }) =>
      (row.original.discount ?? 0) > 0
        ? formatCurrency(row.original.discount ?? 0)
        : "-",
  },
  {
    accessorKey: "total",
    header: "Total",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-medium text-foreground">
        {formatCurrency(row.original.total)}
      </span>
    ),
  },
];

export function BillingItemsTable({
  data,
  emptyTitle,
  className,
}: {
  data: BillingItemTableRow[];
  /** Libellé de l'état vide (« Aucun article dans cette facture »…). */
  emptyTitle: string;
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      className={className}
      emptyIcon={FileText}
      emptyTitle={emptyTitle}
      emptyDescription="Les lignes de ce document apparaîtront ici."
    />
  );
}
