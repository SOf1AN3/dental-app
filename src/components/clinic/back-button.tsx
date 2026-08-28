"use client";

import { useRouter } from "next/navigation";

/**
 * Client-side "← Retour" button using browser history (UX-1).
 * Falls back to a hard navigation path when no history entry exists
 * (e.g. direct URL access / new tab).
 */
export function BackButton({
  fallback,
  label = "\u2190 Retour",
}: {
  fallback: string;
  label?: string;
}) {
  const router = useRouter();

  return (
    <button
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallback);
        }
      }}
      className="text-sm text-cerulean hover:text-cerulean/80 mb-2 inline-block"
    >
      {label}
    </button>
  );
}
