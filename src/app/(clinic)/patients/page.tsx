import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, asc, ilike, or, count as countFn, and, isNull } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { getPatients, getPatientsCount } from "@/lib/actions/patient";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { PatientSearch } from "@/components/clinic/patient-search";
import { PatientPagination } from "@/components/clinic/patient-pagination";
import { PatientTable } from "@/components/clinic/patient-table";
import { PageHeader } from "@/components/ui/page-header";

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
      <PageHeader
        title="Patients"
        description={`${totalCount} patient${totalCount > 1 ? "s" : ""}`}
        actions={
          <Link
            href="/patients/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <UserPlus className="size-4" aria-hidden="true" />
            Nouveau patient
          </Link>
        }
      />

      <PatientSearch />

      <div className="mt-4">
        <PatientTable data={patientList} />
      </div>

      <PatientPagination currentPage={currentPage} totalPages={totalPages} />
    </div>
  );
}
