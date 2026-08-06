"use client";

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import { TreatmentCatalogCombobox } from "@/components/clinic/treatment-catalog-combobox";
import {
  getActiveCatalogOptions,
  type CatalogItem,
  type CatalogOption,
} from "@/lib/treatment-catalog-utils";

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  total: number;
}

interface InvoiceLineItemsProps {
  items?: LineItem[];
  catalog?: CatalogItem[];
}

export function InvoiceLineItems({ items: initialItems, catalog }: InvoiceLineItemsProps) {
  const [items, setItems] = useState<LineItem[]>(
    initialItems || [
      { id: crypto.randomUUID(), description: "", quantity: 1, unitPrice: 0, taxRate: 0, total: 0 },
    ]
  );

  const activeOptions = useMemo(() => getActiveCatalogOptions(catalog ?? []), [catalog]);

  function updateItem(id: string, field: keyof LineItem, value: string | number) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: typeof value === "string" ? value : value };
        if (field === "quantity" || field === "unitPrice") {
          updated.total = updated.quantity * updated.unitPrice;
        }
        return updated;
      })
    );
  }

  function addItem() {
    setItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), description: "", quantity: 1, unitPrice: 0, taxRate: 0, total: 0 },
    ]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function selectCatalogItem(id: string, opt: CatalogOption) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const unitPrice = opt.price;
        return { ...item, description: opt.name, unitPrice, total: unitPrice * item.quantity };
      })
    );
  }

  const grandTotal = items.reduce((sum, item) => sum + item.total, 0);

  return (
    <div>
      <input type="hidden" name="items" value={JSON.stringify(items.map((item) => {
        const { id, ...rest } = item;
        void id;
        return rest;
      }))} />
      <input type="hidden" name="total" value={grandTotal} />
      <input type="hidden" name="subtotal" value={grandTotal} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase">Description</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Qté</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">Prix unitaire</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-cool-500 uppercase">TVA %</th>
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
              <td colSpan={4} className="px-3 py-2 text-right text-sm font-semibold text-cool-900">
                Total
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold text-cool-900">
                {formatCurrency(grandTotal)}
              </td>
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
