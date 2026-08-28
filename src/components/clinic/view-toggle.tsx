"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ViewOption = { label: string; value: string };

/**
 * Search-param-driven view toggle (RDV-1).
 * Renders two pill buttons that switch the `?view=` param without a full
 * page reload (shallow navigation via pushState).
 */
export function ViewToggle({
  options,
  param = "view",
}: {
  options: ViewOption[];
  param?: string;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const current = searchParams.get(param) ?? options[0]?.value;

  function switchView(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === options[0]?.value) {
      next.delete(param);
    } else {
      next.set(param, value);
    }
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }

  return (
    <div className="mb-4 flex items-center gap-1 rounded-lg border border-cool-200 bg-cool-50 p-0.5">
      {options.map((opt) => {
        const active = current === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => switchView(opt.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-white text-cool-900 shadow-sm"
                : "text-cool-500 hover:text-cool-700"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
