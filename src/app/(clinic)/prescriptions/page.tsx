import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescriptions } from "@/lib/actions/prescription";
import { formatDate } from "@/lib/utils";
import { PrescriptionStatusBadge } from "@/components/clinic/prescription-status-badge";
import Link from "next/link";

export default async function PrescriptionsPage() {
  await requireAuth();
  await getCurrentClinicId();

  const prescriptionList = await getPrescriptions();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Ordonnances</h1>
          <p className="text-sm text-cool-500">{prescriptionList.length} ordonnance{prescriptionList.length !== 1 ? "s" : ""}</p>
        </div>
        <Link
          href="/prescriptions/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouvelle ordonnance
        </Link>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Patient
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Date
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Statut
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Notes
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {prescriptionList.map((rx) => {
              const patient = rx.patient;
              return (
                <tr
                  key={rx.id}
                  className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-cool-900">
                    <Link
                      href={`/prescriptions/${rx.id}`}
                      className="text-cerulean hover:text-cerulean/80"
                    >
                      {patient ? `${patient.lastName} ${patient.firstName}` : "-"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-cool-600">
                    {formatDate(rx.date)}
                  </td>
                  <td className="px-4 py-3">
                    <PrescriptionStatusBadge status={rx.status} />
                  </td>
                  <td className="px-4 py-3 text-cool-600 max-w-xs truncate">
                    {rx.notes || "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/prescriptions/${rx.id}`}
                      className="text-sm text-cerulean hover:text-cerulean/80"
                    >
                      Détails
                    </Link>
                  </td>
                </tr>
              );
            })}
            {prescriptionList.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-cool-400">
                  Aucune ordonnance trouvée
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
