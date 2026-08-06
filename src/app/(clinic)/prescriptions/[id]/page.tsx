import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getPrescription, updatePrescriptionStatus } from "@/lib/actions/prescription";
import { formatDate } from "@/lib/utils";
import { PrescriptionStatusBadge } from "@/components/clinic/prescription-status-badge";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Pencil, Printer } from "lucide-react";

export default async function PrescriptionDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const rx = await getPrescription(id);
  if (!rx) notFound();

  const items = rx.items || [];
  const patient = rx.patient;

  const isTerminal = rx.status === "completed" || rx.status === "cancelled";

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/prescriptions"
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour aux ordonnances
        </Link>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-cool-900">
                Ordonnance
              </h1>
              <PrescriptionStatusBadge status={rx.status} />
            </div>
            <p className="text-sm text-cool-500">
              Date: {formatDate(rx.date)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/prescriptions/${id}/edit`}
              className="flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
            >
              <Pencil className="h-4 w-4" />
              Modifier
            </Link>
            <Link
              href={`/prescriptions/${id}/print`}
              target="_blank"
              className="flex items-center gap-2 rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
            >
              <Printer className="h-4 w-4" />
              Imprimer (A5)
            </Link>
          </div>
        </div>

        {patient && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-cool-400 uppercase tracking-wider mb-1">
              Patient
            </p>
            <p className="font-medium text-cool-900">
              {patient.lastName} {patient.firstName}
            </p>
          </div>
        )}

        {rx.notes && (
          <div className="rounded-lg bg-cool-50 p-4 mb-4">
            <p className="text-xs text-cool-400 uppercase tracking-wider mb-1">
              Notes
            </p>
            <p className="text-sm text-cool-700 whitespace-pre-wrap">
              {rx.notes}
            </p>
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-cool-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 bg-cool-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Nom
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Dosage
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Forme
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Fréquence
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Durée
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Qté
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                    Instructions
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-cool-600">
                      {item.type === "medication" ? "Médicament" : "Soin"}
                    </td>
                    <td className="px-4 py-3 font-medium text-cool-900">
                      {item.name}
                    </td>
                    <td className="px-4 py-3 text-cool-600">
                      {item.dosage || "-"}
                    </td>
                    <td className="px-4 py-3 text-cool-600">
                      {item.form || "-"}
                    </td>
                    <td className="px-4 py-3 text-cool-600">
                      {item.frequency || "-"}
                    </td>
                    <td className="px-4 py-3 text-cool-600">
                      {item.duration || "-"}
                    </td>
                    <td className="px-4 py-3 text-cool-600">
                      {item.quantity != null ? item.quantity : "-"}
                    </td>
                    <td className="px-4 py-3 text-cool-600 max-w-xs truncate">
                      {item.instructions || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {items.length === 0 && (
          <p className="text-sm text-cool-400 py-8 text-center">
            Aucun article dans cette ordonnance
          </p>
        )}
      </div>

      {!isTerminal && (
        <div className="flex items-center gap-3">
          {rx.status === "active" && (
            <form action={updatePrescriptionStatus.bind(null, id, "completed")}>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
              >
                Marquer complétée
              </button>
            </form>
          )}
          <form action={updatePrescriptionStatus.bind(null, id, "cancelled")}>
            <button
              type="submit"
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              Annuler
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
