"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SearchInput() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && value.trim()) {
      router.push(`/patients?q=${encodeURIComponent(value.trim())}`);
    }
  }

  return (
    <input
      type="search"
      placeholder="Rechercher un patient..."
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className="w-80 rounded-lg border border-cool-200 bg-cool-50 px-3 py-1.5 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none dark:border-cool-300 dark:bg-cool-100 dark:text-cool-900 dark:placeholder-cool-500"
    />
  );
}
