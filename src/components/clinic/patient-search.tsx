"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

export function PatientSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function handleSearch(term: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (term) {
        params.set("q", term);
      } else {
        params.delete("q");
      }
      router.push(`/patients?${params.toString()}`);
    }, 300);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <input
      type="search"
      placeholder="Rechercher un patient..."
      defaultValue={searchParams.get("q") || ""}
      onChange={(e) => handleSearch(e.target.value)}
      className="w-full max-w-md rounded-lg border border-cool-200 bg-white dark:bg-cool-100 px-3 py-2 text-sm placeholder-cool-400 focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
    />
  );
}
