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
      className="w-full max-w-md rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-fg focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
    />
  );
}
