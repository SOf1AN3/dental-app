"use client";

import Link from "next/link";
import { FileSignature } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `quote` (id, number, date, validUntil, status, total) plus le
 * nom du patient fourni par la jointure `patients` côté serveur.
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 */
export type QuoteTableRow = {
  id: string;
  number: string;
  date: Date;
  validUntil: Date | null;
  status: string;
  total: number;
  patientFirstName: string | null;
  patientLastName: string | null;
};

/** « Nom Prénom » si la jointure a trouvé le patient, sinon « - ». */
function formatPatientName(row: QuoteTableRow): string {
  if (!row.patientLastName && !row.patientFirstName) return "-";
  return `${row.patientLastName ?? ""} ${row.patientFirstName ?? ""}`.trim();
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * Le filtre de statut est appliqué côté serveur (`searchParams.status` +
 * `getQuotes`) : un tri « client » ne trierait que les lignes déjà
 * chargées tout en laissant croire à l'utilisateur qu'il trierait
 * l'ensemble de la liste. Le tri sera branché sur `searchParams` +
 * `orderBy` côté serveur dans une tâche ultérieure.
 */
const columns: ColumnDef<QuoteTableRow>[] = [
  {
    accessorKey: "number",
    header: "N°",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/billing/quotes/${row.original.id}`}
        className="whitespace-nowrap font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.number}
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
    accessorKey: "patientLastName",
    header: "Patient",
    enableSorting: false,
    cell: ({ row }) => formatPatientName(row.original),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => <StatusBadge status={row.original.status} domain="quote" />,
  },
  {
    accessorKey: "total",
    header: "Total",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {formatCurrency(row.original.total)}
      </span>
    ),
  },
  {
    accessorKey: "validUntil",
    header: "Validité",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.validUntil ? (
        <span className="whitespace-nowrap">
          {formatDate(row.original.validUntil)}
        </span>
      ) : (
        "-"
      ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/billing/quotes/${row.original.id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Détails
      </Link>
    ),
  },
];

export function QuoteTable({ data }: { data: QuoteTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={FileSignature}
      emptyTitle="Aucun devis"
      emptyDescription="Créez un devis ou modifiez le filtre de statut."
    />
  );
}
