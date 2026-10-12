"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function SearchInput() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && value.trim()) {
      router.push(`/patients?q=${encodeURIComponent(value.trim())}`);
    }
  }

  // Champ dédié plutôt que le composant `Input` de `ui/input.tsx` : ce
  // dernier est `h-8 w-full` et ciblé pour les formulaires, alors que ce
  // champ doit rester `w-80` dans la barre d'en-tête. On garde donc le
  // `<input>` natif en réutilisant les mêmes tokens/focus qu'`Input`.
  return (
    <input
      type="search"
      aria-label="Rechercher un patient"
      placeholder="Rechercher un patient..."
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn(
        "w-80 rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-fg",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      )}
    />
  );
}
