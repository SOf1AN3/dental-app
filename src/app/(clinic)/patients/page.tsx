import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, asc, ilike, or, count as countFn, and, isNull } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { getPatients, getPatientsCount } from "@/lib/actions/patient";
import Link from "next/link";
import { PatientSearch } from "@/components/clinic/patient-search";
import { PatientPagination } from "@/components/clinic/patient-pagination";

const PAGE_SIZE = 20;

export default async function PatientsPage(props: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const searchParams = await props.searchParams;

  const query = searchParams.q || "";
  const currentPage = Math.max(1, Number(searchParams.page) || 1);

  let patientList;
  let totalCount: number;

  if (query) {
    const offset = (currentPage - 1) * PAGE_SIZE;
    const whereConditions = and(
      eq(patients.clinicId, clinicId),
      isNull(patients.deletedAt),
      or(
        ilike(patients.firstName, `%${query}%`),
        ilike(patients.lastName, `%${query}%`),
        ilike(patients.phone, `%${query}%`),
      ),
    );

    [patientList, [{ count: totalCount }]] = await Promise.all([
      db
        .select()
        .from(patients)
        .where(whereConditions)
        .orderBy(asc(patients.lastName), asc(patients.firstName))
        .limit(PAGE_SIZE)
        .offset(offset),
      db
        .select({ count: countFn() })
        .from(patients)
        .where(whereConditions),
    ]);
  } else {
    [patientList, totalCount] = await Promise.all([
      getPatients(currentPage, PAGE_SIZE),
      getPatientsCount(),
    ]);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Patients</h1>
          <p className="text-sm text-cool-500">{totalCount} patients</p>
        </div>
        <Link
          href="/patients/new"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          + Nouveau patient
        </Link>
      </div>

      <PatientSearch />

      <div className="mt-4 overflow-x-auto rounded-xl border border-cool-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Nom
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Téléphone
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Genre
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {patientList.map((patient) => (
              <tr
                key={patient.id}
                className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/patients/${patient.id}`}
                    className="font-medium text-cerulean hover:text-cerulean/80"
                  >
                    {patient.lastName} {patient.firstName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {patient.phone || "-"}
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {patient.email || "-"}
                </td>
                <td className="px-4 py-3 text-cool-600">
                  {patient.gender || "-"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/patients/${patient.id}`}
                      className="text-sm text-cerulean hover:text-cerulean/80"
                    >
                      Dossier
                    </Link>
                    <Link
                      href={`/patients/${patient.id}/edit`}
                      className="text-sm text-cool-500 hover:text-cool-700"
                    >
                      Modifier
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {patientList.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-cool-400"
                >
                  Aucun patient trouvé
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <PatientPagination currentPage={currentPage} totalPages={totalPages} />
    </div>
  );
}
