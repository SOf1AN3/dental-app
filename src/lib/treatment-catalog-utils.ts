export interface CatalogItem {
  id: string;
  name: string;
  code: string | null;
  price: number;
  isActive: boolean;
}

export interface CatalogOption {
  id: string;
  name: string;
  code: string | null;
  price: number;
}

export function toCatalogOption(item: CatalogItem): CatalogOption {
  return {
    id: item.id,
    name: item.name,
    code: item.code,
    price: item.price,
  };
}

export function getActiveCatalogOptions(items: CatalogItem[]): CatalogOption[] {
  return items.filter((item) => item.isActive).map(toCatalogOption);
}

export function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function matchesCatalogQuery(option: CatalogOption, query: string): boolean {
  if (query === "") return true;
  const normalizedQuery = normalizeForSearch(query);
  return (
    normalizeForSearch(option.name).includes(normalizedQuery) ||
    (option.code !== null && normalizeForSearch(option.code).includes(normalizedQuery))
  );
}
