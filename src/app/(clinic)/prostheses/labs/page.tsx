import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getLabs } from "@/lib/actions/prosthesis";
import Link from "next/link";

export default async function LabsPage() {
  await requireAuth();
  await getCurrentClinicId();

  const labs = await getLabs();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Laboratoires</h1>
          <p className="text-sm text-cool-500">{labs.length} laboratoires</p>
        </div>
        <Link
          href="/prostheses/labs/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouveau laboratoire
        </Link>
      </div>

      {labs.length === 0 ? (
        <div className="rounded-xl border border-cool-200 bg-white px-6 py-12 text-center text-cool-400">
          <p className="text-lg mb-1">Aucun laboratoire</p>
          <p className="text-sm">
            Ajoutez un{" "}
            <Link href="/prostheses/labs/new" className="text-cerulean hover:text-cerulean/80">
              nouveau laboratoire
            </Link>{" "}
            pour commencer.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {labs.map((lab) => (
            <Link
              key={lab.id}
              href={`/prostheses/labs/${lab.id}`}
              className="rounded-xl border border-cool-200 bg-white p-6 hover:border-cerulean hover:shadow-sm transition-all"
            >
              <h3 className="text-lg font-semibold text-cool-900">{lab.name}</h3>
              {lab.contactPerson && (
                <p className="mt-1 text-sm text-cool-500">{lab.contactPerson}</p>
              )}
              <div className="mt-4 space-y-1 text-sm text-cool-600">
                {lab.phone && (
                  <p>
                    <span className="text-cool-400">Tél: </span>
                    {lab.phone}
                  </p>
                )}
                {lab.email && (
                  <p>
                    <span className="text-cool-400">Email: </span>
                    {lab.email}
                  </p>
                )}
                {lab.address && (
                  <p>
                    <span className="text-cool-400">Adresse: </span>
                    {lab.address}
                  </p>
                )}
              </div>
              {!lab.phone && !lab.email && !lab.address && (
                <p className="mt-2 text-sm text-cool-400">Aucune information de contact</p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
