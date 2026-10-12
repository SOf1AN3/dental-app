"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux colonnes non
 * nulles du table `patient` : id, firstName, lastName (text notNull) et
 * phone, email, gender (text nullable).
 */
export type PatientTableRow = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La page pagine côté serveur (limit/offset, PAGE_SIZE = 20) : un tri
 * « client » ne trierait que les 20 lignes de la page courante tout en
 * laissant croire à l'utilisateur qu'il trierait l'ensemble de la liste.
 * Un faux tri sur une liste paginée est pire que pas de tri.
 *
 * Le tri sera branché sur `searchParams` + `orderBy` côté serveur dans une
 * tâche ultérieure.
 */
const columns: ColumnDef<PatientTableRow>[] = [
  {
    accessorKey: "lastName",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/patients/${row.original.id}`}
        className="font-medium text-cerulean hover:text-cerulean/80"
      >
        {row.original.lastName} {row.original.firstName}
      </Link>
    ),
  },
  {
    accessorKey: "phone",
    header: "Téléphone",
    enableSorting: false,
    cell: ({ row }) => row.original.phone || "-",
  },
  {
    accessorKey: "email",
    header: "Email",
    enableSorting: false,
    cell: ({ row }) => row.original.email || "-",
  },
  {
    accessorKey: "gender",
    header: "Genre",
    enableSorting: false,
    cell: ({ row }) => row.original.gender || "-",
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Link
          href={`/patients/${row.original.id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Dossier
        </Link>
        <Link
          href={`/patients/${row.original.id}/edit`}
          className="text-sm text-muted-fg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Modifier
        </Link>
      </div>
    ),
  },
];

export function PatientTable({ data }: { data: PatientTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Users}
      emptyTitle="Aucun patient trouvé"
      emptyDescription="Ajoutez votre premier patient pour commencer."
    />
  );
}
