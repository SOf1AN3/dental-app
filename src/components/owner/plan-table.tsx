"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { CreditCard } from "lucide-react";

import { DataTable } from "@/components/shared/data-table";
import { PlanActions } from "@/components/owner/plan-actions";

/**
 * Ligne telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle) : le contrat de
 * sérialisation reste visible et vérifiable. Correspond aux champs affichés
 * d'un plan d'abonnement (id, name, code, prix, quotas, isActive).
 *
 * Seules des données plates traversent la frontière : aucune fonction,
 * aucune Server Action, aucun composant n'est transmis depuis la page.
 */
export type PlanTableRow = {
  id: string;
  name: string;
  code: string;
  priceMonthly: number;
  priceYearly: number | null;
  maxStaff: number | null;
  maxPatients: number | null;
  isActive: boolean;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * La liste est ordonnée côté serveur (`getSubscriptionPlans`) : un tri
 * « client » ne trierait que les lignes déjà chargées tout en laissant
 * croire à l'utilisateur qu'il trierait l'ensemble de la liste.
 */
const planColumns: ColumnDef<PlanTableRow>[] = [
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
    accessorKey: "code",
    header: "Code",
    enableSorting: false,
    cell: ({ row }) => <span className="font-mono">{row.original.code}</span>,
  },
  {
    accessorKey: "priceMonthly",
    header: "Mensuel",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {row.original.priceMonthly.toLocaleString("fr-DZ")} DZD
      </span>
    ),
  },
  {
    accessorKey: "priceYearly",
    header: "Annuel",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {row.original.priceYearly
          ? `${row.original.priceYearly.toLocaleString("fr-DZ")} DZD`
          : "-"}
      </span>
    ),
  },
  {
    accessorKey: "isActive",
    header: "Actif",
    enableSorting: false,
    cell: ({ row }) => (
      // `isActive` est un booléen et non un statut d'enum : le badge StatusBadge
      // (libellés d'enum) ne s'applique pas, on garde le libellé Oui/Non.
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
          row.original.isActive ? "bg-mint/10 text-mint" : "bg-cool-100 text-cool-500"
        }`}
      >
        {row.original.isActive ? "Oui" : "Non"}
      </span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => <PlanActions plan={row.original} />,
  },
];

export function PlanTable({ data }: { data: PlanTableRow[] }) {
  return (
    <DataTable
      columns={planColumns}
      data={data}
      emptyIcon={CreditCard}
      emptyTitle="Aucun plan"
      emptyDescription="Les plans d'abonnement créés apparaîtront ici."
    />
  );
}
