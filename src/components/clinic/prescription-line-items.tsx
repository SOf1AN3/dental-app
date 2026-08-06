"use client";

import type { A5Item } from "@/components/clinic/a5-prescription";

/**
 * Local line item used by the editor. `quantity` may be "" while the user is
 * typing / clearing the field; it is normalized to `null` before submit.
 */
export interface PrescriptionLineItem extends Omit<A5Item, "quantity"> {
  id: string; // local key
  quantity: number | "" | null;
}

interface PrescriptionLineItemsProps {
  items: PrescriptionLineItem[];
  onChange: (items: PrescriptionLineItem[]) => void;
}

const inputClassName =
  "mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean";

function emptyLineItem(): PrescriptionLineItem {
  return {
    id: crypto.randomUUID(),
    type: "medication",
    name: "",
    dosage: "",
    form: "",
    frequency: "",
    duration: "",
    quantity: null,
    instructions: "",
  };
}

export function PrescriptionLineItems({ items, onChange }: PrescriptionLineItemsProps) {
  function updateItem(
    id: string,
    field: keyof PrescriptionLineItem,
    value: string | number
  ) {
    onChange(
      items.map((item) => {
        if (item.id !== id) return item;
        return { ...item, [field]: value };
      })
    );
  }

  function addItem() {
    onChange([...items, emptyLineItem()]);
  }

  function removeItem(id: string) {
    onChange(items.filter((item) => item.id !== id));
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Articles de l&apos;ordonnance</caption>
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Type
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Nom*
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Dosage
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Forme
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Fréquence
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Durée
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Qté
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Instructions
              </th>
              <th scope="col" className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} className="border-b border-cool-100">
                <td className="px-3 py-2">
                  <select
                    value={item.type}
                    onChange={(e) => updateItem(item.id, "type", e.target.value)}
                    aria-label={`Type de l'article ${index + 1}`}
                    className={inputClassName}
                  >
                    <option value="medication">Médicament</option>
                    <option value="care">Soin</option>
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.name}
                    onChange={(e) => updateItem(item.id, "name", e.target.value)}
                    placeholder="Nom"
                    aria-label={`Nom de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.dosage ?? ""}
                    onChange={(e) => updateItem(item.id, "dosage", e.target.value)}
                    placeholder="Dosage"
                    aria-label={`Dosage de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.form ?? ""}
                    onChange={(e) => updateItem(item.id, "form", e.target.value)}
                    placeholder="Forme"
                    aria-label={`Forme de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.frequency ?? ""}
                    onChange={(e) => updateItem(item.id, "frequency", e.target.value)}
                    placeholder="Fréquence"
                    aria-label={`Fréquence de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.duration ?? ""}
                    onChange={(e) => updateItem(item.id, "duration", e.target.value)}
                    placeholder="Durée"
                    aria-label={`Durée de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={item.quantity ?? ""}
                    onChange={(e) =>
                      updateItem(
                        item.id,
                        "quantity",
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                    placeholder="Qté"
                    aria-label={`Quantité de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={item.instructions ?? ""}
                    onChange={(e) => updateItem(item.id, "instructions", e.target.value)}
                    placeholder="Instructions"
                    aria-label={`Instructions de l'article ${index + 1}`}
                    className={inputClassName}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    aria-label={`Supprimer l'article ${item.name || index + 1}`}
                    className="text-xs text-danger hover:text-danger/80"
                  >
                    Suppr.
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addItem}
        className="mt-2 text-sm text-cerulean hover:text-cerulean/80"
      >
        + Ajouter un article
      </button>
    </div>
  );
}
