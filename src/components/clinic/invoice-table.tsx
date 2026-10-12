"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * de la table `invoice` (id, number, date, dueDate, status, total) plus le
 * nom du patient fourni par la jointure `patients` côté serveur.
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 */
export type InvoiceTableRow = {
  id: string;
  number: string;
  date: Date;
  dueDate: Date | null;
  status: string;
  total: number;
  patientFirstName: string | null;
  patientLastName: string | null;
};

/** « Nom Prénom » si la jointure a trouvé le patient, sinon « - ». */
function formatPatientName(row: InvoiceTableRow): string {
  if (!row.patientLastName && !row.patientFirstName) return "-";
  return `${row.patientLastName ?? ""} ${row.patientFirstName ?? ""}`.trim();
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * Le filtre de statut est appliqué côté serveur (`searchParams.status` +
 * `getInvoices`) : un tri « client » ne trierait que les lignes déjà
 * chargées tout en laissant croire à l'utilisateur qu'il trierait
 * l'ensemble de la liste. Le tri sera branché sur `searchParams` +
 * `orderBy` côté serveur dans une tâche ultérieure.
 */
const columns: ColumnDef<InvoiceTableRow>[] = [
  {
    accessorKey: "number",
    header: "N°",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.number}
      </span>
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
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="invoice" />
    ),
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
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <Link
          href={`/billing/invoices/${row.original.id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Détails
        </Link>
        {row.original.status !== "paid" &&
        row.original.status !== "cancelled" ? (
          <Link
            href={`/billing/payments/new?invoiceId=${row.original.id}`}
            className="text-sm text-emerald-600 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Paiement
          </Link>
        ) : null}
      </div>
    ),
  },
];

export function InvoiceTable({ data }: { data: InvoiceTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={FileText}
      emptyTitle="Aucune facture"
      emptyDescription="Créez une facture ou modifiez le filtre de statut."
    />
  );
}
