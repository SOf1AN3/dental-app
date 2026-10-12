"use client";

import Link from "next/link";
import { Stethoscope } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * du plan de traitement (id, title, status, totalAmount, createdAt), à
 * l'identifiant/nom du patient fournis par la jointure `patients`
 * (INNER JOIN : toujours présent) et au compteur d'articles calculé
 * côté serveur.
 */
export type TreatmentPlanTableRow = {
  id: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  title: string;
  status: string;
  itemsCount: number;
  totalAmount: number | null;
  createdAt: Date;
};

/** Lien de détail du plan, identique à l'ancien rendu serveur. */
function planHref(row: TreatmentPlanTableRow): string {
  return `/patients/${row.patientId}/treatment-plan/${row.id}`;
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La page charge déjà tous les plans de la clinique (tri serveur par date de
 * création décroissante) : un tri « client » ne trierait que les lignes déjà
 * chargées tout en laissant croire à l'utilisateur qu'il trierait l'ensemble.
 * Le tri sera branché sur `searchParams` + `orderBy` côté serveur dans une
 * tâche ultérieure.
 */
const columns: ColumnDef<TreatmentPlanTableRow>[] = [
  {
    accessorKey: "patientLastName",
    header: "Patient",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={planHref(row.original)}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.patientLastName} {row.original.patientFirstName}
      </Link>
    ),
  },
  {
    accessorKey: "title",
    header: "Titre",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-xs truncate">{row.original.title}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="treatmentPlan" />
    ),
  },
  {
    accessorKey: "itemsCount",
    header: "Articles",
    enableSorting: false,
    cell: ({ row }) => row.original.itemsCount,
  },
  {
    accessorKey: "totalAmount",
    header: "Montant",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.totalAmount != null
          ? formatCurrency(row.original.totalAmount)
          : "-"}
      </span>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDate(row.original.createdAt)}</span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={planHref(row.original)}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Détails
      </Link>
    ),
  },
];

export function TreatmentPlanTable({ data }: { data: TreatmentPlanTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Stethoscope}
      emptyTitle="Aucun plan de traitement"
      emptyDescription="Créez un plan de traitement depuis la fiche d'un patient."
    />
  );
}
