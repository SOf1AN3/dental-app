"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type SidebarGroup = "pilotage" | "clinique" | "suivi" | "reglages";

export interface SidebarLink {
  label: string;
  href: string;
  icon: React.ElementType;
  /** Groupe d'appartenance — sert au regroupement visuel */
  group: SidebarGroup;
}

/** Ordre d'affichage des sections dans la sidebar. */
const GROUP_ORDER: readonly SidebarGroup[] = [
  "pilotage",
  "clinique",
  "suivi",
  "reglages",
];

const GROUP_LABELS: Record<SidebarGroup, string> = {
  pilotage: "Pilotage",
  clinique: "Clinique",
  suivi: "Suivi",
  reglages: "Réglages",
};

/**
 * Détermine si une entrée de navigation correspond à la route courante.
 *
 * `pathname.startsWith(href + "/")` couvre les routes enfantes :
 * sur `/patients/123` (fiche patient), `pathname` vaut `/patients/123` et non
 * `/patients`, un comparateur strict laisserait donc la fiche sans lien actif.
 * Le garde `href !== "/dashboard"` empêche un href de racine engloutir toutes
 * les routes (précaution défensive : `pathname.startsWith("/dashboard/")`
 * reste correct aujourd'hui, mais une racine "/" ne le serait pas).
 */
function isLinkActive(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(`${href}/`))
  );
}

export function SidebarNav({ links }: { links: SidebarLink[] }) {
  const pathname = usePathname();

  // Regroupement sans dépendance externe : on parcourt une seule fois le
  // tableau et on conserve l'ordre de `GROUP_ORDER` pour le rendu.
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    links: links.filter((link) => link.group === group),
  })).filter((section) => section.links.length > 0);

  return (
    <>
      {grouped.map((section, index) => (
        <div key={section.group}>
          {/*
            `<p>` et non `<h2>`/`<h3>` : ce libellé est un simple regroupement
            visuel du menu, pas un titre sémantique de section du document.
            Des niveaux de titres ici faussent l'arbre de navigation par
            titres (screen readers) alors que la navigation est déjà décrite
            par le `<nav>` et sa liste de liens.
          */}
          <p
            className={cn(
              "px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/40",
              index === 0 ? "pt-1" : "pt-4"
            )}
          >
            {GROUP_LABELS[section.group]}
          </p>
          <ul className="space-y-1 px-3">
            {section.links.map((link) => {
              const isActive = isLinkActive(pathname, link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                      isActive
                        ? "bg-white/15 font-medium text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    <link.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>{link.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
