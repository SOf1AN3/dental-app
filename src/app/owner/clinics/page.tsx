import { requirePlatformOwner } from "@/lib/auth-utils";
import { getClinics, getArchivedClinics } from "@/lib/actions/owner";
import { Archive } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { ArchivedClinicTable, ClinicTable } from "@/components/owner/clinic-table";

export default async function OwnerClinicsPage() {
  await requirePlatformOwner();
  const [clinicList, archivedClinics] = await Promise.all([
    getClinics(),
    getArchivedClinics(),
  ]);

  return (
    <div>
      <PageHeader
        title="Cliniques"
        description={`${clinicList.length} cliniques`}
      />

      <ClinicTable data={clinicList} />

      {archivedClinics.length > 0 ? (
        <section className="mt-8" aria-labelledby="archived-clinics-heading">
          <h2
            id="archived-clinics-heading"
            className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground"
          >
            <Archive className="h-5 w-5 text-muted-fg" aria-hidden="true" />
            Cliniques archivées
          </h2>
          <ArchivedClinicTable data={archivedClinics} />
        </section>
      ) : null}
    </div>
  );
}
