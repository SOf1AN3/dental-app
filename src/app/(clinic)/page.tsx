import { requireAuth, getCurrentRole } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { ReceptionDashboard } from "@/components/clinic/dashboard/reception-dashboard";
import { DentistDashboard } from "@/components/clinic/dashboard/dentist-dashboard";
import { OwnerDashboard } from "@/components/clinic/dashboard/owner-dashboard";
import { ViewToggle } from "@/components/clinic/view-toggle";
import { redirect } from "next/navigation";

/**
 * Role router (DB-2/DB-3/DB-4). Each dashboard scopes its own queries;
 * global revenue is only ever fetched on the owner path (RAP-1).
 */
export default async function ClinicDashboard(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  const role = await getCurrentRole(clinicId);
  const { view } = await props.searchParams;

  if (view === "agenda") {
    redirect("/appointments/agenda");
  }

  return (
    <>
      <ViewToggle
        options={[
          { label: "Tableau de bord", value: "dashboard" },
          { label: "Agenda", value: "agenda" },
        ]}
      />
      {role === "receptionist" && <ReceptionDashboard clinicId={clinicId} />}
      {(role === "dentist" || role === "assistant") && (
        <DentistDashboard
          clinicId={clinicId}
          dentistUserId={user.id}
          showRevenue={role === "dentist"}
        />
      )}
      {(role === "owner" || role === "viewer") && (
        <OwnerDashboard clinicId={clinicId} />
      )}
    </>
  );
}
