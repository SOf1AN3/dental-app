"use client";

import Link from "next/link";
import { Bone, FlaskConical } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate } from "@/lib/utils";

/**
 * Ligne « commande » telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `prosthesesOrders`) :
 * le contrat de sérialisation reste visible et vérifiable. La page aplatit le
 * triplet `{ order, patient, lab }` renvoyé par `getOrders` avant d'envoyer.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type ProsthesisTableRow = {
  id: string;
  orderNumber: string;
  description: string;
  status: string;
  deliveryDate: Date | null;
  patientId: string;
  patientFirstName: string | null;
  patientLastName: string | null;
  labName: string | null;
};

/**
 * Ligne « laboratoire » (deuxième tableau de la page Prothèses), issue de la
 * table `prosthesisLabs`. Même contrat de sérialisation que ci-dessus.
 */
export type ProsthesisLabTableRow = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
};

/** « Nom Prénom » si les champs sont renseignés, sinon « - ». */
function formatPatientName(row: ProsthesisTableRow): string {
  if (!row.patientLastName && !row.patientFirstName) return "-";
  return `${row.patientLastName ?? ""} ${row.patientFirstName ?? ""}`.trim();
}

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes.
 *
 * L'ordonnancement est imposé côté serveur (`getOrders` → `orderBy(createdAt
 * desc)`, `getLabs` → `orderBy(name)`) : un tri « client » ne trierait que les
 * lignes déjà chargées tout en laissant croire à l'utilisateur qu'il trierait
 * l'ensemble de la liste. Le tri sera branché sur `searchParams` + `orderBy`
 * côté serveur dans une tâche ultérieure.
 */
const orderColumns: ColumnDef<ProsthesisTableRow>[] = [
  {
    accessorKey: "orderNumber",
    header: "N° commande",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-medium text-foreground">
        {row.original.orderNumber}
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
        className="text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {formatPatientName(row.original)}
      </Link>
    ),
  },
  {
    accessorKey: "description",
    header: "Description",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-xs truncate">{row.original.description}</span>
    ),
  },
  {
    id: "lab",
    header: "Labo",
    enableSorting: false,
    cell: ({ row }) => row.original.labName || "-",
  },
  {
    accessorKey: "status",
    header: "Statut",
    enableSorting: false,
    // `domain="prosthesis"` : sans lui, `in_progress` tombe sur le libellé
    // générique « En cours » au lieu de « En fabrication » (enum dédié).
    cell: ({ row }) => (
      <StatusBadge status={row.original.status} domain="prosthesis" />
    ),
  },
  {
    accessorKey: "deliveryDate",
    header: "Date livraison",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        {row.original.deliveryDate ? formatDate(row.original.deliveryDate) : "-"}
      </span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prostheses/orders/${row.original.id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Détails
      </Link>
    ),
  },
];

const labColumns: ColumnDef<ProsthesisLabTableRow>[] = [
  {
    accessorKey: "name",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prostheses/labs/${row.original.id}`}
        className="font-medium text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "contactPerson",
    header: "Contact",
    enableSorting: false,
    cell: ({ row }) => row.original.contactPerson || "-",
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
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/prostheses/labs/${row.original.id}`}
        className="text-sm text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Détails
      </Link>
    ),
  },
];

interface ProsthesisTableProps {
  data: ProsthesisTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}

interface ProsthesisLabTableProps {
  data: ProsthesisLabTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}

/** Tableau des commandes de prothèses (premier tableau de la page). */
export function ProsthesisTable({ data, className }: ProsthesisTableProps) {
  return (
    <DataTable
      columns={orderColumns}
      data={data}
      className={className}
      emptyIcon={Bone}
      emptyTitle="Aucune prothèse"
      emptyDescription={
        <>
          Commencez par{" "}
          <Link
            href="/prostheses/orders/new"
            className="text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            créer une nouvelle commande
          </Link>
          .
        </>
      }
    />
  );
}

/** Tableau des laboratoires (second tableau de la page). */
export function ProsthesisLabTable({ data, className }: ProsthesisLabTableProps) {
  return (
    <DataTable
      columns={labColumns}
      data={data}
      className={className}
      emptyIcon={FlaskConical}
      emptyTitle="Aucun laboratoire"
      emptyDescription={
        <>
          Ajoutez un{" "}
          <Link
            href="/prostheses/labs/new"
            className="text-cerulean hover:text-cerulean/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            nouveau laboratoire
          </Link>{" "}
          pour commencer.
        </>
      }
    />
  );
}
