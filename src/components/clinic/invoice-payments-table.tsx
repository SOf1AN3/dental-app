"use client";

import { HandCoins } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Ligne de paiement telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `payments`) : le
 * contrat de sérialisation reste visible et vérifiable.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type PaymentTableRow = {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  date: Date;
};

const methodLabels: Record<string, string> = {
  cash: "Espèces",
  check: "Chèque",
  card: "Carte bancaire",
  transfer: "Virement",
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre des
 * paiements est imposé côté serveur.
 */
const columns: ColumnDef<PaymentTableRow>[] = [
  {
    accessorKey: "date",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDate(row.original.date)}</span>
    ),
  },
  {
    accessorKey: "method",
    header: "Méthode",
    enableSorting: false,
    cell: ({ row }) => methodLabels[row.original.method] || row.original.method,
  },
  {
    accessorKey: "reference",
    header: "Référence",
    enableSorting: false,
    cell: ({ row }) => row.original.reference || "-",
  },
  {
    accessorKey: "amount",
    header: "Montant",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-medium text-foreground">
        {formatCurrency(row.original.amount)}
      </span>
    ),
  },
];

export function InvoicePaymentsTable({
  data,
  className,
}: {
  data: PaymentTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      className={className}
      emptyIcon={HandCoins}
      emptyTitle="Aucun paiement enregistré"
      emptyDescription="Enregistrez un paiement pour suivre l'encaissement de cette facture."
    />
  );
}
