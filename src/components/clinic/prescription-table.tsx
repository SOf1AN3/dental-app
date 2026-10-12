"use client";

import Link from "next/link";
import { Pill } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `prescription` (id, date, status, notes) plus l'identifiant et
 * le nom du patient fournis par la jointure `patients` (INNER JOIN : toujours
 * présent).
 */
export type PrescriptionTableRow = {
  id: string;
  date: Date;
  status: string;
  notes: string | null;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La page charge déjà la liste complète des ordonnances de la clinique (tri
 * serveur par date décroissante) : un tri « client » ne trierait que les
 * lignes déjà chargées tout en laissant croire à l'utilisateur qu'il trierait
 * l'ensemble. Le tri sera branché sur `searchParams` + `orderBy` côté serveur
 * dans une tâche ultérieure.
 */
const columns: ColumnDef<PrescriptionTableRow>[] = [
  {
    accessorKey: "patientLastName",
    header: "Patient",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prescriptions/${row.original.id}`}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.patientLastName} {row.original.patientFirstName}
      </Link>
    ),
  },
  {
    accessorKey: "date",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDate(row.original.date)}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="prescription" />
    ),
  },
  {
    accessorKey: "notes",
    header: "Notes",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-xs truncate">{row.original.notes || "-"}</span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prescriptions/${row.original.id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Détails
      </Link>
    ),
  },
];

export function PrescriptionTable({ data }: { data: PrescriptionTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Pill}
      emptyTitle="Aucune ordonnance trouvée"
    />
  );
}
