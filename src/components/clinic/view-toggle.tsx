"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

type ViewOption = { label: string; value: string };

/**
 * Search-param-driven view toggle (RDV-1).
 * Renders two pill buttons that switch the `?view=` param without a full
 * page reload (shallow navigation via pushState).
 *
 * `role="group"` + `aria-label` : les boutons pilotent une seule et même
 * zone (la vue affichée), pas des actions indépendantes. Le groupe permet
 * au lecteur d'écran d'annoncer le contexte (« Choisir la vue, groupe »)
 * puis l'état de chaque bascule via `aria-pressed`.
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
    <div
      role="group"
      aria-label="Choisir la vue"
      className="mb-4 flex items-center gap-1 rounded-lg border border-border-card bg-cool-50 p-0.5"
    >
      {options.map((opt) => {
        const active = current === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => switchView(opt.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "bg-card text-cool-900 shadow-sm"
                : "text-muted-fg hover:text-cool-900"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
