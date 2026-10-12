"use client";

import { useMemo, useState } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxPopup,
  ComboboxPortal,
  ComboboxPositioner,
} from "@/components/ui/combobox";
import { cn, formatCurrency } from "@/lib/utils";
import { matchesCatalogQuery, type CatalogOption } from "@/lib/treatment-catalog-utils";

interface TreatmentCatalogComboboxProps {
  options: CatalogOption[];
  value: string;
  onValueChange: (text: string) => void;
  onSelectOption: (option: CatalogOption) => void;
  placeholder?: string;
  className?: string;
  name?: string;
}

export function TreatmentCatalogCombobox({
  options,
  value,
  onValueChange,
  onSelectOption,
  placeholder,
  className,
  name,
}: TreatmentCatalogComboboxProps) {
  const [selected, setSelected] = useState<CatalogOption | null>(null);

  const filter = useMemo(
    () => (opt: CatalogOption, query: string) => matchesCatalogQuery(opt, query),
    [],
  );

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(v) => {
        if (v) {
          setSelected(v);
          onSelectOption(v);
        }
      }}
      inputValue={value}
      onInputValueChange={(v) => onValueChange(v)}
      filter={filter}
      autoHighlight
      itemToStringLabel={(opt: CatalogOption) => opt.name}
    >
      <ComboboxInput
        name={name}
        placeholder={placeholder}
        className={cn(
          "block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none",
          className,
        )}
      />
      <ComboboxPortal>
        <ComboboxPositioner>
          <ComboboxPopup>
            <ComboboxEmpty>Aucun traitement trouvé</ComboboxEmpty>
            <ComboboxList>
              {(opt: CatalogOption) => (
                <ComboboxItem key={opt.id} value={opt}>
                  <span className="flex flex-1 items-center gap-2 truncate">
                    <span className="truncate">{opt.name}</span>
                    {opt.code && <span className="text-xs text-cool-400">{opt.code}</span>}
                  </span>
                  <span className="ml-auto text-xs text-cool-500 tabular-nums">
                    {formatCurrency(opt.price)}
                  </span>
                  <ComboboxItemIndicator />
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  );
}
