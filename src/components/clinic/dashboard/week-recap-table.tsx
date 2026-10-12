"use client";

import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { formatCurrency } from "@/lib/utils";

/**
 * Enveloppe client du tableau « Récapitulatif des 4 dernières semaines » du
 * dashboard dentiste (DB-3).
 *
 * Patron identique à `report-tables.tsx` : les colonnes (et leurs `cell`)
 * sont définies DANS ce module client ; seule de la donnée plate traverse la
 * frontière serveur/client — aucun composant, aucune fonction, aucune
 * Server Action n'est transmis depuis le Server Component.
 *
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre des
 * semaines (S-3 → S-0) est imposé côté serveur.
 *
 * La colonne « Encaissé » n'existe que si `showRevenue` est vrai — un
 * assistant n'a jamais accès aux montants (RAP-1), et la colonne ne doit
 * donc même pas être déclarée dans ce cas.
 */
export type WeekRecapRow = {
  /** Libellé de la semaine, ex. « S-0 (en cours) ». */
  label: string;
  /** Nombre de rendez-vous sur la semaine. */
  appointments: number;
  /** Montant encaissé sur la semaine (jamais affiché si `showRevenue` est faux). */
  revenue: number;
};

function buildColumns(showRevenue: boolean): ColumnDef<WeekRecapRow>[] {
  const columns: ColumnDef<WeekRecapRow>[] = [
    {
      accessorKey: "label",
      header: "Semaine",
      enableSorting: false,
    },
    {
      accessorKey: "appointments",
      header: () => <span className="block text-right">RDV</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block text-right">{row.original.appointments}</span>
      ),
    },
  ];

  if (showRevenue) {
    columns.push({
      accessorKey: "revenue",
      header: () => <span className="block text-right">Encaissé</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block text-right font-medium text-foreground">
          {formatCurrency(row.original.revenue)}
        </span>
      ),
    });
  }

  return columns;
}

export function WeekRecapTable({
  weeks,
  showRevenue,
}: {
  weeks: WeekRecapRow[];
  showRevenue: boolean;
}) {
  return (
    <DataTable
      columns={buildColumns(showRevenue)}
      data={weeks}
      compact
      // À plat dans la carte du dashboard : le cadre vient du conteneur serveur.
      className="mt-4 border-0 bg-transparent shadow-none"
      emptyTitle="Aucune donnée"
      emptyDescription="Aucun rendez-vous sur les 4 dernières semaines."
    />
  );
}
