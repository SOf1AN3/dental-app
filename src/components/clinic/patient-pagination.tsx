"use client";

import { useRouter, useSearchParams } from "next/navigation";

interface PatientPaginationProps {
  currentPage: number;
  totalPages: number;
}

export function PatientPagination({ currentPage, totalPages }: PatientPaginationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function goToPage(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    router.replace(`/patients?${params.toString()}`);
  }

  if (totalPages <= 1) return null;

  const pages: number[] = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(i);
  }

  return (
    <div className="mt-6 flex items-center justify-center gap-2">
      <button
        onClick={() => goToPage(currentPage - 1)}
        disabled={currentPage <= 1}
        className="rounded-lg border border-cool-200 px-3 py-1.5 text-sm text-cool-600 hover:bg-cool-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Précédent
      </button>

      {pages.map((page) => (
        <button
          key={page}
          onClick={() => goToPage(page)}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
            page === currentPage
              ? "bg-primary text-white"
              : "border border-cool-200 text-cool-600 hover:bg-cool-50"
          }`}
        >
          {page}
        </button>
      ))}

      <button
        onClick={() => goToPage(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="rounded-lg border border-cool-200 px-3 py-1.5 text-sm text-cool-600 hover:bg-cool-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Suivant
      </button>
    </div>
  );
}
