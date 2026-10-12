"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Archive, Building2 } from "lucide-react";

import { ClinicActions } from "@/components/owner/clinic-actions";
import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `clinic` (id, name, slug, email, status, createdAt, deletedAt)
 * plus le flag `restorable` calculé côté serveur pour les cliniques archivées.
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 */
export type ClinicTableRow = {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  status: string;
  createdAt: Date;
  deletedAt: Date | null;
};

export type ArchivedClinicTableRow = ClinicTableRow & {
  restorable: boolean;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * Les listes sont ordonnées côté serveur (`getClinics` / `getArchivedClinics`)
 * : un tri « client » ne trierait que les lignes déjà chargées tout en laissant
 * croire à l'utilisateur qu'il trierait l'ensemble de la liste.
 */
const clinicColumns: ColumnDef<ClinicTableRow>[] = [
  {
    accessorKey: "name",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.name}
      </span>
    ),
  },
  {
    accessorKey: "slug",
    header: "Slug",
    enableSorting: false,
    cell: ({ row }) => <span className="font-mono">{row.original.slug}</span>,
  },
  {
    accessorKey: "email",
    header: "Email",
    enableSorting: false,
    cell: ({ row }) => <span>{row.original.email ?? "-"}</span>,
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="clinic" />
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Création",
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
    cell: ({ row }) => <ClinicActions clinic={row.original} />,
  },
];

const archivedClinicColumns: ColumnDef<ArchivedClinicTableRow>[] = [
  {
    accessorKey: "name",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.name}
      </span>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
    enableSorting: false,
    cell: ({ row }) => <span>{row.original.email ?? "-"}</span>,
  },
  {
    accessorKey: "deletedAt",
    header: "Archivé le",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {row.original.deletedAt ? formatDate(row.original.deletedAt) : "-"}
      </span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <ClinicActions clinic={row.original} restorable={row.original.restorable} />
    ),
  },
];

export function ClinicTable({ data }: { data: ClinicTableRow[] }) {
  return (
    <DataTable
      columns={clinicColumns}
      data={data}
      emptyIcon={Building2}
      emptyTitle="Aucune clinique"
      emptyDescription="Les cliniques enregistrées apparaîtront ici."
    />
  );
}

export function ArchivedClinicTable({ data }: { data: ArchivedClinicTableRow[] }) {
  return (
    <DataTable
      columns={archivedClinicColumns}
      data={data}
      emptyIcon={Archive}
      emptyTitle="Aucune clinique archivée"
      emptyDescription="Les cliniques archivées apparaîtront ici."
    />
  );
}
