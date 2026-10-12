"use client";

import Link from "next/link";
import { ClipboardList } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { ProsthesisStatusBadge } from "@/components/clinic/prosthesis-status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne « commande d'un laboratoire » telle qu'elle traverse la frontière
 * serveur/client. Structure explicite (et non dérivée du schema Drizzle) :
 * le contrat de sérialisation reste visible et vérifiable. La page aplatit le
 * triplet `{ order, patient }` renvoyé par `getLabOrders` avant d'envoyer.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type LabOrderTableRow = {
  id: string;
  orderNumber: string;
  patientFirstName: string | null;
  patientLastName: string | null;
  status: string;
  createdAt: Date;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre est
 * imposé côté serveur, un tri « client » ne trierait que les lignes chargées.
 */
const columns: ColumnDef<LabOrderTableRow>[] = [
  {
    accessorKey: "orderNumber",
    header: "N° commande",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prostheses/orders/${row.original.id}`}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.orderNumber}
      </Link>
    ),
  },
  {
    accessorKey: "patientLastName",
    header: "Patient",
    enableSorting: false,
    cell: ({ row }) =>
      `${row.original.patientLastName ?? ""} ${row.original.patientFirstName ?? ""}`.trim() ||
      "-",
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => <ProsthesisStatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {formatDate(row.original.createdAt)}
      </span>
    ),
  },
];

export function LabOrdersTable({
  data,
  className,
}: {
  data: LabOrderTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      className={className}
      emptyIcon={ClipboardList}
      emptyTitle="Aucune commande pour ce laboratoire"
      emptyDescription="Les commandes rattachées à ce laboratoire apparaîtront ici."
    />
  );
}
