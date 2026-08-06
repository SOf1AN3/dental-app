"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-cool-900">Une erreur est survenue</h2>
        <p className="mt-2 text-cool-500">{error.message}</p>
        <button
          onClick={reset}
          className="mt-6 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}
