"use client";

import { CalendarDays, CreditCard, PieChart } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { formatCurrency } from "@/lib/utils";

/**
 * Enveloppes client des tableaux de la page « Rapports & Analyses ».
 *
 * Patron identique à `invoice-table.tsx` : les colonnes (et leurs fonctions
 * `cell`) sont définies DANS ce module client — seule de la donnée plate
 * (string / number) traverse la frontière serveur/client, jamais une fonction.
 *
 * Arbitrage sur le tri (toutes les colonnes : `enableSorting: true`) :
 * les trois jeux de données viennent d'agrégations `GROUP BY` serveur qui
 * renvoient le résultat COMPLET en mémoire (6 lignes pour les tendances
 * mensuelles, quelques lignes par type / méthode). Aucun `LIMIT`, aucune
 * pagination serveur : un tri client ne peut pas masquer de lignes, il
 * réordonne l'intégralité de l'ensemble. C'est le cas légitime où le tri
 * client est honnête. À l'inverse, si ces requêtes étaient paginées, le tri
 * serait désactivé (cf. `invoice-table.tsx`).
 *
 * Le mois au format `YYYY-MM` (clé zéro-paddée) trie lexicographiquement en
 * ordre chronologique, ce qui rend la colonne « Mois » triable sans calcul
 * supplémentaire.
 */

/* Lignes sérialisables traversant la frontière serveur/client. */

export type MonthlyTrendRow = {
  month: string;
  patients: number;
  appointments: number;
  revenue: number;
};

export type AppointmentTypeRow = {
  /** `appointments.type` est nullable en base → affichage « - » si vide. */
  type: string | null;
  count: number;
};

export type PaymentMethodRow = {
  method: string;
  amount: number;
};

const methodLabels: Record<string, string> = {
  cash: "Espèces",
  check: "Chèque",
  card: "Carte bancaire",
  transfer: "Virement",
};

function formatMonthKey(key: string): string {
  const [year, month] = key.split("-")
  const date = new Date(parseInt(year), parseInt(month) - 1, 1)
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date)
}

/* ── Aperçu mensuel ─────────────────────────────────────────────────── */

const monthlyColumns: ColumnDef<MonthlyTrendRow>[] = [
  {
    accessorKey: "month",
    header: "Mois",
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium capitalize text-foreground">
        {formatMonthKey(row.original.month)}
      </span>
    ),
  },
  {
    accessorKey: "patients",
    header: "Patients",
    cell: ({ row }) => row.original.patients,
  },
  {
    accessorKey: "appointments",
    header: "Rendez-vous",
    cell: ({ row }) => row.original.appointments,
  },
  {
    accessorKey: "revenue",
    header: "Encaissé",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {formatCurrency(row.original.revenue)}
      </span>
    ),
  },
];

export function MonthlyTrendsTable({ data }: { data: MonthlyTrendRow[] }) {
  return (
    <DataTable
      columns={monthlyColumns}
      data={data}
      emptyIcon={CalendarDays}
      emptyTitle="Aucune donnée disponible"
      emptyDescription="Les statistiques apparaîtront dès le premier rendez-vous enregistré."
    />
  );
}

/* ── Répartition des rendez-vous (par type) ─────────────────────────── */

const appointmentTypeColumns: ColumnDef<AppointmentTypeRow>[] = [
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => (
      <span className="font-medium capitalize text-foreground">
        {row.original.type ?? "-"}
      </span>
    ),
  },
  {
    accessorKey: "count",
    header: "Nombre",
    cell: ({ row }) => row.original.count,
  },
];

export function AppointmentTypeTable({ data }: { data: AppointmentTypeRow[] }) {
  return (
    <DataTable
      columns={appointmentTypeColumns}
      data={data}
      emptyIcon={PieChart}
      emptyTitle="Aucun rendez-vous"
      emptyDescription="Aucun rendez-vous enregistré pour le moment."
    />
  );
}

/* ── Méthodes de paiement ───────────────────────────────────────────── */

const paymentMethodColumns: ColumnDef<PaymentMethodRow>[] = [
  {
    accessorKey: "method",
    header: "Méthode",
    cell: ({ row }) => (
      <span className="font-medium text-foreground">
        {methodLabels[row.original.method] ?? row.original.method}
      </span>
    ),
  },
  {
    accessorKey: "amount",
    header: "Montant",
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {formatCurrency(row.original.amount)}
      </span>
    ),
  },
];

export function PaymentMethodTable({ data }: { data: PaymentMethodRow[] }) {
  return (
    <DataTable
      columns={paymentMethodColumns}
      data={data}
      emptyIcon={CreditCard}
      emptyTitle="Aucun paiement enregistré"
      emptyDescription="Les paiements apparaîtront ici après leur enregistrement."
    />
  );
}
