"use client";

import Link from "next/link";
import { CalendarDays } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { AppointmentActions } from "@/components/clinic/appointment-actions";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `appointment` (id, startTime, endTime, type, status) plus
 * l'identifiant et le nom du patient fournis par la jointure `patients`.
 */
export type AppointmentTableRow = {
  id: string;
  startTime: Date;
  endTime: Date;
  type: string | null;
  status: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
};

/** HH:MM en français, identique à l'ancien rendu serveur. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La page filtre par date côté serveur et affiche l'agenda complet de cette
 * date : un tri « client » ne trierait que les lignes déjà chargées tout en
 * laissant croire à l'utilisateur qu'il trierait l'ensemble. Le tri sera
 * branché sur `searchParams` + `orderBy` côté serveur dans une tâche ultérieure.
 */
const columns: ColumnDef<AppointmentTableRow>[] = [
  {
    accessorKey: "startTime",
    header: "Horaire",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        <span className="font-medium text-foreground">
          {formatTime(row.original.startTime)}
        </span>
        <span className="mx-1 text-muted-fg">-</span>
        <span className="text-muted-fg">{formatTime(row.original.endTime)}</span>
      </span>
    ),
  },
  {
    accessorKey: "patientLastName",
    header: "Patient",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/patients/${row.original.patientId}`}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.patientLastName} {row.original.patientFirstName}
      </Link>
    ),
  },
  {
    accessorKey: "type",
    header: "Type",
    enableSorting: false,
    cell: ({ row }) => row.original.type || "-",
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="appointment" />
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => <AppointmentActions appointment={row.original} />,
  },
];

export function AppointmentTable({ data }: { data: AppointmentTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={CalendarDays}
      emptyTitle="Aucun rendez-vous pour cette date"
      emptyDescription="Créez un rendez-vous ou sélectionnez une autre date."
    />
  );
}
