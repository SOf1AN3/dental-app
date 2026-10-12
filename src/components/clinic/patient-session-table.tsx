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
 * de la table `clinical_session` (id, patientId, createdAt, status,
 * totalAmount) plus la facture éventuellement liée (jointure `invoice`),
 * réduite à son identifiant et son numéro.
 */
export type PatientSessionTableRow = {
  id: string;
  patientId: string;
  createdAt: Date;
  status: string;
  totalAmount: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
};

/**
 * Le tri est ACTIVÉ sur « Date » et « Total » uniquement.
 *
 * La page charge la liste COMPLÈTE des séances du patient en mémoire
 * (`getSessions(id)` — aucun filtre, aucune pagination, déjà triée par date
 * décroissante côté serveur) : un tri « client » porte donc bien sur
 * l'ensemble des lignes. Le statut (enum) et la colonne « Facture » (lien)
 * ne se trient pas de façon pertinente et restent désactivés.
 */
const columns: ColumnDef<PatientSessionTableRow>[] = [
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDate(row.original.createdAt)}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="session" />
    ),
  },
  {
    accessorKey: "totalAmount",
    header: "Total",
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {formatCurrency(row.original.totalAmount)}
      </span>
    ),
  },
  {
    id: "invoice",
    header: "Facture",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.invoiceId && row.original.invoiceNumber ? (
        <Link
          href={`/billing/invoices/${row.original.invoiceId}`}
          className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {row.original.invoiceNumber}
        </Link>
      ) : (
        <span className="text-muted-fg">—</span>
      ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/patients/${row.original.patientId}/session/${row.original.id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Ouvrir
      </Link>
    ),
  },
];

export function PatientSessionTable({ data }: { data: PatientSessionTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      emptyIcon={Stethoscope}
      emptyTitle="Aucune séance pour ce patient"
    />
  );
}
