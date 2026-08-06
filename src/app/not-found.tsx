import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4">
      <div className="text-center">
        <h2 className="text-6xl font-bold text-primary">404</h2>
        <p className="mt-4 text-lg text-cool-500">Page non trouvée</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
