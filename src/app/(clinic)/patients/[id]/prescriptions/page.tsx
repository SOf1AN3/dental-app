import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescriptions } from "@/lib/actions/prescription";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { formatDate } from "@/lib/utils";
import { PrescriptionStatusBadge } from "@/components/clinic/prescription-status-badge";
import { notFound } from "next/navigation";
import Link from "next/link";

export default async function PatientPrescriptionsPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const prescriptionList = await getPrescriptions(id);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href={`/patients/${id}`}
            className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
          >
            ← Retour au dossier patient
          </Link>
          <h1 className="text-2xl font-bold text-cool-900">
            Ordonnances — {patient.lastName} {patient.firstName}
          </h1>
          <p className="text-sm text-cool-500">
            {prescriptionList.length} ordonnance{prescriptionList.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href={`/prescriptions/new?patientId=${id}`}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouvelle ordonnance
        </Link>
      </div>

      {prescriptionList.length === 0 ? (
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-12 text-center">
          <p className="text-sm text-cool-400">
            Aucune ordonnance pour ce patient
          </p>
          <Link
            href={`/prescriptions/new?patientId=${id}`}
            className="mt-4 inline-block rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light transition-colors"
          >
            Créer une ordonnance
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cool-200 bg-cool-50">
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
              {prescriptionList.map((rx) => (
                <tr
                  key={rx.id}
                  className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                >
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
