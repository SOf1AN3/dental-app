"use client";

import Link from "next/link";
import { Pill } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `prescription` (id, date, status, notes) pour un patient
 * donné — la colonne « Patient » de `PrescriptionTable` est redondante ici.
 */
export type PatientPrescriptionTableRow = {
  id: string;
  date: Date;
  status: string;
  notes: string | null;
};

/**
 * Le tri est ACTIVÉ sur la colonne « Date » uniquement.
 *
 * La page charge la liste COMPLÈTE des ordonnances du patient en mémoire
 * (`getPrescriptions(id)` — aucun filtre `searchParams`, aucune pagination) :
 * un tri « client » porte donc bien sur l'ensemble des lignes, ce qui est
 * honnête vis-à-vis de l'utilisateur. Les autres colonnes restent triées de
 * façon non pertinente (statut = enum, notes tronquées, actions = liens) et
 * sont donc désactivées.
 */
const columns: ColumnDef<PatientPrescriptionTableRow>[] = [
  {
    accessorKey: "date",
    header: "Date",
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
      <span className="block max-w-xs truncate">
        {row.original.notes || "-"}
      </span>
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

export function PatientPrescriptionTable({
  data,
  emptyAction,
}: {
  data: PatientPrescriptionTableRow[];
  /** CTA rendu dans l'état vide (ex : « Créer une ordonnance ») */
  emptyAction?: ReactNode;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Pill}
      emptyTitle="Aucune ordonnance pour ce patient"
      emptyAction={emptyAction}
    />
  );
}
