"use client";

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  /** Classes additionnelles sur le conteneur racine */
  className?: string;
  /** Rendu optionnel quand `data` est vide (ex: bouton de création) */
  emptyAction?: ReactNode;
  /** Réduit les paddings — pour les tableaux imbriqués ou denses */
  compact?: boolean;
  /** Icône de l'état vide (défaut : Inbox) */
  emptyIcon?: LucideIcon;
  /** Titre de l'état vide (défaut : « Aucune donnée ») */
  emptyTitle?: string;
  /** Description de l'état vide */
  emptyDescription?: ReactNode;
  /** État de tri contrôlé — si fourni, le composant ne garde plus d'état interne */
  sorting?: SortingState;
  /** Callback de changement de tri */
  onSortingChange?: (sorting: SortingState) => void;
}

type SortDirection = "ascending" | "descending" | "none";

function getAriaSort(isSorted: false | "asc" | "desc"): SortDirection {
  if (isSorted === "asc") return "ascending";
  if (isSorted === "desc") return "descending";
  return "none";
}

export function DataTable<TData>({
  columns,
  data,
  className,
  emptyAction,
  compact = false,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  sorting,
  onSortingChange,
}: DataTableProps<TData>) {
  const isControlled = sorting !== undefined;
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const activeSorting = isControlled ? sorting : internalSorting;

  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const nextSorting =
      typeof updater === "function" ? updater(activeSorting) : updater;

    if (!isControlled) {
      setInternalSorting(nextSorting);
    }
    onSortingChange?.(nextSorting);
  };

  const cellPadding = compact ? "px-3 py-2" : "px-4 py-3";

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack useReactTable returns non-memoizable functions by design
  const table = useReactTable({
    data,
    columns,
    state: { sorting: activeSorting },
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const isEmpty = data.length === 0;

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-xl border border-border-card bg-card",
        className
      )}
    >
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr
              key={headerGroup.id}
              className="border-b border-border-card bg-cool-50 dark:bg-cool-100"
            >
              {headerGroup.headers.map((header) => {
                const isSorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();

                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={canSort ? getAriaSort(isSorted) : undefined}
                    className={cn(
                      cellPadding,
                      "text-left text-xs font-medium text-muted-fg uppercase tracking-wider"
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : canSort
                        ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 cursor-pointer transition-colors hover:text-cool-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                            {isSorted === "asc" ? (
                              <ArrowUp className="size-3" aria-hidden="true" />
                            ) : isSorted === "desc" ? (
                              <ArrowDown className="size-3" aria-hidden="true" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
                            )}
                          </button>
                        )
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        {isEmpty ? null : (
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border-card/60 last:border-b-0 hover:bg-cool-50 dark:hover:bg-cool-100/60 transition-colors"
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(cellPadding, "text-cool-700 dark:text-cool-800")}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
      {isEmpty ? (
        <EmptyState
          icon={emptyIcon ?? Inbox}
          title={emptyTitle ?? "Aucune donnée"}
          description={emptyDescription ?? "Aucun élément à afficher pour le moment."}
          action={emptyAction}
        />
      ) : null}
    </div>
  );
}
