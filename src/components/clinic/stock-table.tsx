"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StockStatusBadge } from "@/components/clinic/stock-status-badge";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `stockItems`) : le
 * contrat de sérialisation reste visible et vérifiable. Correspond aux champs
 * affichés par la page Stock (nom, catégorie, quantité, seuil, unité).
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type StockTableRow = {
  id: string;
  name: string;
  category: string | null;
  currentQty: number;
  minQty: number;
  unit: string | null;
};

/** Même règle de seuil que la page : sous le minimum = stock bas. */
function isLowStock(row: StockTableRow): boolean {
  return row.currentQty < row.minQty;
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * L'ordonnancement est imposé côté serveur (`getStockItems` → `orderBy(name)`) :
 * un tri « client » ne trierait que les lignes déjà chargées tout en laissant
 * croire à l'utilisateur qu'il trierait l'ensemble de la liste. Le tri sera
 * branché sur `searchParams` + `orderBy` côté serveur dans une tâche ultérieure.
 */
const columns: ColumnDef<StockTableRow>[] = [
  {
    accessorKey: "name",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/stock/${row.original.id}`}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "category",
    header: "Catégorie",
    enableSorting: false,
    cell: ({ row }) => row.original.category || "-",
  },
  {
    accessorKey: "currentQty",
    header: "Quantité",
    enableSorting: false,
    cell: ({ row }) => (
      <span
        className={
          isLowStock(row.original)
            ? "font-medium text-red-600 dark:text-red-400"
            : "font-medium text-cool-900"
        }
      >
        {row.original.currentQty}
      </span>
    ),
  },
  {
    accessorKey: "minQty",
    header: "Seuil",
    enableSorting: false,
    cell: ({ row }) => <span className="text-cool-500">{row.original.minQty}</span>,
  },
  {
    accessorKey: "unit",
    header: "Unité",
    enableSorting: false,
    cell: ({ row }) => row.original.unit || "-",
  },
  {
    id: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StockStatusBadge
        currentQty={row.original.currentQty}
        minQty={row.original.minQty}
      />
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Link
          href={`/stock/${row.original.id}?tx=in`}
          className="text-xs font-medium text-mint hover:text-mint/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Entrée
        </Link>
        <Link
          href={`/stock/${row.original.id}?tx=out`}
          className="text-xs font-medium text-red-600 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Sortie
        </Link>
        <Link
          href={`/stock/${row.original.id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Détails
        </Link>
      </div>
    ),
  },
];

export function StockTable({ data }: { data: StockTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Package}
      emptyTitle="Aucun article en stock"
      emptyDescription="Créez un article pour commencer à suivre votre stock."
    />
  );
}
