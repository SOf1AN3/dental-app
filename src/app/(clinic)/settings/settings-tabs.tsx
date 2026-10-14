"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useIsDesktop } from "@/hooks/use-desktop";

const tabs = [
  { label: "Général", href: "/settings/general" },
  { label: "Documents", href: "/settings/documents" },
  { label: "Horaires", href: "/settings/schedule" },
  { label: "Membres", href: "/settings/members" },
  { label: "Catalogues", href: "/settings/catalogues" },
  { label: "Abonnement", href: "/settings/subscription" },
  // La synchronisation n'existe que dans l'application de bureau : le moteur
  // (push/pull, conflits, bootstrap) n'est embarqué que dans Electron, et la
  // page elle-même affiche un état neutre en web. L'onglet est donc rendu
  // uniquement en desktop pour ne pas modifier l'interface web.
  { label: "Synchronisation", href: "/settings/sync", desktopOnly: true },
];

export function SettingsTabs() {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();

  return (
    <div className="mb-6 flex gap-1 border-b border-cool-200">
      {tabs
        .filter((tab) => !tab.desktopOnly || isDesktop)
        .map((tab) => {
          const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "text-cerulean border-cerulean"
                  : "text-cool-500 hover:text-cool-900 border-transparent hover:border-cerulean"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
    </div>
  );
}
