"use client";

import { Pill } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/shared/data-table";

/**
 * Ligne d'ordonnance telle qu'elle traverse la frontière serveur/client.
 *
 * Structure explicite (et non dérivée du schema Drizzle `prescriptionItems`) :
 * le contrat de sérialisation reste visible et vérifiable.
 *
 * Seules des données plates traversent la frontière : aucune fonction, aucune
 * Server Action, aucun composant n'est transmis depuis la page.
 */
export type PrescriptionItemTableRow = {
  id: string;
  type: string;
  name: string;
  dosage: string | null;
  form: string | null;
  frequency: string | null;
  duration: string | null;
  quantity: number | null;
  instructions: string | null;
};

/**
 * Le tri est volontairement DÉSACTIVÉ sur toutes les colonnes : l'ordre des
 * lignes est imposé côté serveur (`orderIndex`, avec repli alphabétique).
 */
const columns: ColumnDef<PrescriptionItemTableRow>[] = [
  {
    accessorKey: "type",
    header: "Type",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.type === "medication" ? "Médicament" : "Soin",
  },
  {
    accessorKey: "name",
    header: "Nom",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-medium text-foreground">{row.original.name}</span>
    ),
  },
  {
    accessorKey: "dosage",
    header: "Dosage",
    enableSorting: false,
    cell: ({ row }) => row.original.dosage || "-",
  },
  {
    accessorKey: "form",
    header: "Forme",
    enableSorting: false,
    cell: ({ row }) => row.original.form || "-",
  },
  {
    accessorKey: "frequency",
    header: "Fréquence",
    enableSorting: false,
    cell: ({ row }) => row.original.frequency || "-",
  },
  {
    accessorKey: "duration",
    header: "Durée",
    enableSorting: false,
    cell: ({ row }) => row.original.duration || "-",
  },
  {
    accessorKey: "quantity",
    header: "Qté",
    enableSorting: false,
    cell: ({ row }) => row.original.quantity ?? "-",
  },
  {
    accessorKey: "instructions",
    header: "Instructions",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-xs truncate">
        {row.original.instructions || "-"}
      </span>
    ),
  },
];

export function PrescriptionItemsTable({
  data,
  className,
}: {
  data: PrescriptionItemTableRow[];
  /** Classes additionnelles sur le conteneur (ex: à plat dans une carte). */
  className?: string;
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      className={className}
      emptyIcon={Pill}
      emptyTitle="Aucun article dans cette ordonnance"
      emptyDescription="Ajoutez des médicaments ou des soins depuis l'éditeur d'ordonnance."
    />
  );
}
