"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Receipt } from "lucide-react";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la vue de facturation plateforme (abonnement + clinique + plan).
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 */
export type BillingTableRow = {
  id: string;
  clinicName: string;
  planName: string;
  startDate: Date;
  endDate: Date | null;
  status: string;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La liste est ordonnée côté serveur (`getBillingData`) : un tri « client »
 * ne trierait que les lignes déjà chargées tout en laissant croire à
 * l'utilisateur qu'il trierait l'ensemble de la liste.
 */
const billingColumns: ColumnDef<BillingTableRow>[] = [
  {
    accessorKey: "clinicName",
    header: "Clinique",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.clinicName}
      </span>
    ),
  },
  {
    accessorKey: "planName",
    header: "Plan",
    enableSorting: false,
    cell: ({ row }) => <span>{row.original.planName}</span>,
  },
  {
    accessorKey: "startDate",
    header: "Début",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {formatDate(row.original.startDate)}
      </span>
    ),
  },
  {
    accessorKey: "endDate",
    header: "Fin",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {row.original.endDate ? formatDate(row.original.endDate) : "-"}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="subscription" />
    ),
  },
];

export function BillingTable({ data }: { data: BillingTableRow[] }) {
  return (
    <DataTable
      columns={billingColumns}
      data={data}
      emptyIcon={Receipt}
      emptyTitle="Aucune donnée de facturation"
      emptyDescription="Les abonnements des cliniques apparaîtront ici."
    />
  );
}
