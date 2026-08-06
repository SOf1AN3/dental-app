import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getSessions } from "@/lib/actions/session";
import { formatCurrency, formatDate } from "@/lib/utils";
import { SessionStatusBadge } from "@/components/clinic/session-status-badge";
import Link from "next/link";

export default async function PatientSessionsPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const sessions = await getSessions(id);

  return (
    <div>
      <div className="mb-6">
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">Séances cliniques</h1>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-cool-200 bg-white p-12 text-center">
          <p className="text-sm text-cool-400">
            Aucune séance pour ce patient
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cool-200 bg-cool-50">
                <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Statut
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Total
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Facture
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                >
                  <td className="px-4 py-3 text-cool-600">
                    {formatDate(session.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <SessionStatusBadge status={session.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-cool-900">
                    {formatCurrency(session.totalAmount)}
                  </td>
                  <td className="px-4 py-3 text-cool-600">
                    {session.invoice ? (
                      <Link
                        href={`/billing/invoices/${session.invoice.id}`}
                        className="text-sm text-cerulean hover:text-cerulean/80"
                      >
                        {session.invoice.number}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/patients/${id}/session/${session.id}`}
                      className="text-sm text-cerulean hover:text-cerulean/80"
                    >
                      Ouvrir
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
