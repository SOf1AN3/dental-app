import { requirePlatformOwner } from "@/lib/auth-utils";
import { getClinics, getArchivedClinics } from "@/lib/actions/owner";
import { formatDate } from "@/lib/utils";
import { ClinicActions } from "@/components/owner/clinic-actions";
import { Archive } from "lucide-react";

export default async function OwnerClinicsPage() {
  await requirePlatformOwner();
  const [clinicList, archivedClinics] = await Promise.all([
    getClinics(),
    getArchivedClinics(),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Cliniques</h1>
          <p className="text-sm text-cool-500">{clinicList.length} cliniques</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Nom</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Slug</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Email</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Statut</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Création</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clinicList.map((clinic) => (
              <tr key={clinic.id} className="border-b border-cool-100 hover:bg-cool-50">
                <td className="px-4 py-3 font-medium text-cool-900">{clinic.name}</td>
                <td className="px-4 py-3 text-cool-600">{clinic.slug}</td>
                <td className="px-4 py-3 text-cool-600">{clinic.email || "-"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    clinic.status === "active" ? "bg-mint/10 text-mint" :
                    clinic.status === "suspended" ? "bg-danger/10 text-danger" :
                    "bg-amber/10 text-amber-fg"
                  }`}>
                    {clinic.status === "active" ? "Actif" : clinic.status === "suspended" ? "Suspendu" : "Essai"}
                  </span>
                </td>
                <td className="px-4 py-3 text-cool-600">{formatDate(clinic.createdAt)}</td>
                <td className="px-4 py-3">
                  <ClinicActions clinic={clinic} />
                </td>
              </tr>
            ))}
            {clinicList.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-cool-400">
                  Aucune clinique
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {archivedClinics.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-cool-900">
            <Archive className="h-5 w-5 text-cool-400" />
            Cliniques archivées
          </h2>
          <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cool-200 bg-cool-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Nom</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Archivé le</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {archivedClinics.map((clinic) => (
                  <tr key={clinic.id} className="border-b border-cool-100 hover:bg-cool-50">
                    <td className="px-4 py-3 font-medium text-cool-900">{clinic.name}</td>
                    <td className="px-4 py-3 text-cool-600">{clinic.email || "-"}</td>
                    <td className="px-4 py-3 text-cool-600">
                      {clinic.deletedAt ? formatDate(clinic.deletedAt) : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <ClinicActions clinic={clinic} restorable={clinic.restorable} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
