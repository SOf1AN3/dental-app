"use client";

import { useMemo, useState, useEffect } from "react";
import { formatCurrency } from "@/lib/utils";
import { docTotals, lineBase, lineTax, round2 } from "@/lib/billing-math";
import { TreatmentCatalogCombobox } from "@/components/clinic/treatment-catalog-combobox";
import {
  getActiveCatalogOptions,
  type CatalogItem,
  type CatalogOption,
} from "@/lib/treatment-catalog-utils";

/**
 * Shared editable line-items table for invoices and quotes (FACT-5).
 *
 * Totals are computed with the same pure functions as the server
 * (`src/lib/billing-math.ts`) so the live preview always matches what gets
 * stored. The server remains authoritative: amounts sent here are ignored
 * and recomputed on submit.
 */

export interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
  total: number;
}

interface DocumentLineItemsProps {
  items?: LineItem[];
  catalog?: CatalogItem[];
  /** Default VAT % pre-filled on new lines (clinic setting, PAR-3). */
  defaultTaxRate?: number;
  /** Live-change hook used by the parent form to power the A5 preview. */
  onItemsChange?: (items: LineItem[]) => void;
}

function withTotals(item: Omit<LineItem, "total">): LineItem {
  const tax = lineTax(item.quantity, item.unitPrice, item.taxRate);
  return {
    ...item,
    total: round2(lineBase(item.quantity, item.unitPrice) + tax - item.discount),
  };
}

function emptyLineItem(defaultTaxRate: number): LineItem {
  return withTotals({
    id: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unitPrice: 0,
    taxRate: defaultTaxRate,
    discount: 0,
  });
}

export function DocumentLineItems({
  items: initialItems,
  catalog,
  defaultTaxRate = 0,
  onItemsChange,
}: DocumentLineItemsProps) {
  const [items, setItems] = useState<LineItem[]>(
    initialItems?.map((item) => withTotals(item)) || [emptyLineItem(defaultTaxRate)]
  );

  useEffect(() => {
    onItemsChange?.(items);
    // Notify the parent for the live A5 preview; `items` alone is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const activeOptions = useMemo(() => getActiveCatalogOptions(catalog ?? []), [catalog]);

  function updateItem(id: string, field: keyof LineItem, value: string | number) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        return withTotals({ ...item, [field]: value });
      })
    );
  }

  function addItem() {
    setItems((prev) => [...prev, emptyLineItem(defaultTaxRate)]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function selectCatalogItem(id: string, opt: CatalogOption) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        return withTotals({ ...item, description: opt.name, unitPrice: opt.price });
      })
    );
  }

  const totals = docTotals(items);

  return (
    <div>
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(
          items.map((item) => {
            const { id, ...rest } = item;
            void id;
            return rest;
          })
        )}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase">Description</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Qté</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Prix unitaire</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">TVA %</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Remise</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Total</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-cool-100">
                <td className="px-3 py-2">
                  <TreatmentCatalogCombobox
                    options={activeOptions}
                    value={item.description}
                    onValueChange={(t) => updateItem(item.id, "description", t)}
                    onSelectOption={(opt) => selectCatalogItem(item.id, opt)}
                    placeholder="Description"
                    className="w-full rounded border border-cool-200 px-2 py-1 text-sm focus:border-cerulean focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) => updateItem(item.id, "quantity", Number(e.target.value))}
                    className="w-16 rounded border border-cool-200 px-2 py-1 text-right text-sm focus:border-cerulean focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.id, "unitPrice", Number(e.target.value))}
                    className="w-24 rounded border border-cool-200 px-2 py-1 text-right text-sm focus:border-cerulean focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={item.taxRate}
                    onChange={(e) => updateItem(item.id, "taxRate", Number(e.target.value))}
                    className="w-16 rounded border border-cool-200 px-2 py-1 text-right text-sm focus:border-cerulean focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.discount}
                    onChange={(e) => updateItem(item.id, "discount", Number(e.target.value))}
                    className="w-20 rounded border border-cool-200 px-2 py-1 text-right text-sm focus:border-cerulean focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2 text-right font-medium text-cool-900">
                  {formatCurrency(item.total)}
                </td>
                <td className="px-3 py-2">
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="text-xs text-danger hover:text-danger/80"
                    >
                      Suppr.
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right text-sm text-cool-500">
                Sous-total
              </td>
              <td colSpan={2} className="px-3 py-2 text-right text-sm text-cool-700">
                {formatCurrency(totals.subtotal)}
              </td>
              <td></td>
              <td></td>
            </tr>
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right text-sm text-cool-500">
                Total TVA
              </td>
              <td colSpan={2} className="px-3 py-2 text-right text-sm text-cool-700">
                {formatCurrency(totals.taxTotal)}
              </td>
              <td></td>
              <td></td>
            </tr>
            {totals.discountTotal > 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-sm text-cool-500">
                  Total remises
                </td>
                <td colSpan={2} className="px-3 py-2 text-right text-sm text-cool-700">
                  -{formatCurrency(totals.discountTotal)}
                </td>
                <td></td>
                <td></td>
              </tr>
            )}
            <tr>
              <td colSpan={3} className="px-3 py-2 text-right text-sm font-semibold text-cool-900">
                Total
              </td>
              <td colSpan={2} className="px-3 py-2 text-right text-sm font-bold text-cool-900">
                {formatCurrency(totals.total)}
              </td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <button
        type="button"
        onClick={addItem}
        className="mt-2 text-sm text-cerulean hover:text-cerulean/80"
      >
        + Ajouter une ligne
      </button>
    </div>
  );
}
