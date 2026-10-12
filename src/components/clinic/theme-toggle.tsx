"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

// `false` côté serveur, `true` côté client — sans effet, donc sans
// `set-state-in-effect`. Le rendu serveur et client restent identiques
// au premier paint (icône Moon), ce qui corrige l'hydration d'origine.
const subscribe = () => () => {};
const getMountedSnapshot = () => true;
const getServerSnapshot = () => false;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isMounted = useSyncExternalStore(
    subscribe,
    getMountedSnapshot,
    getServerSnapshot
  );

  // Tant que le composant n'est pas monté, on rend exactement le même HTML
  // que le serveur (icône Moon par défaut) pour éviter l'erreur d'hydration.
  const isDark = isMounted && theme === "dark";

  const ariaLabel = !isMounted
    ? "Changer le thème"
    : isDark
      ? "Passer en thème clair"
      : "Passer en thème sombre";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="rounded-full p-2 text-cool-500 hover:bg-cool-100 transition-colors"
      title="Changer le thème"
      aria-label={ariaLabel}
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
