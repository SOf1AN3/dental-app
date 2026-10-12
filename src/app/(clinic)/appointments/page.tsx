import { db } from "@/lib/db/db";
import { appointments, patients, clinics } from "@/lib/db/schema";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { getClinicScheduleDays } from "@/lib/clinic-schedule";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { AppointmentDatePicker } from "@/components/clinic/appointment-date-picker";
import { ViewToggle } from "@/components/clinic/view-toggle";
import { PageHeader } from "@/components/ui/page-header";
import {
  AppointmentTable,
  type AppointmentTableRow,
} from "@/components/clinic/appointment-table";

export default async function AppointmentsPage(props: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const searchParams = await props.searchParams;

  if (searchParams.view === "agenda") {
    const weekParam = searchParams.date ? `?week=${searchParams.date}` : "";
    redirect(`/appointments/agenda${weekParam}`);
  }

  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });
  const schedule = await getClinicScheduleDays(clinicId, clinic?.openingTime ?? "08:00", clinic?.closingTime ?? "19:00");

  const selectedDate = searchParams.date ? new Date(searchParams.date) : new Date();
  const start = new Date(selectedDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(selectedDate);
  end.setHours(23, 59, 59, 999);

  const appointmentList = await db
    .select({
      appointment: appointments,
      patient: patients,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .where(
      and(
        eq(appointments.clinicId, clinicId),
        gte(appointments.startTime, start),
        lte(appointments.startTime, end),
      )
    )
    .orderBy(asc(appointments.startTime));

  // Donnée PLATE et sérialisable : aucune fonction ni référence de composant
  // ne traverse la frontière serveur/client (les colonnes sont définies dans
  // le module client `appointment-table.tsx`).
  const rows: AppointmentTableRow[] = appointmentList.map(
    ({ appointment, patient }) => ({
      id: appointment.id,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      type: appointment.type,
      status: appointment.status,
      patientId: patient.id,
      patientFirstName: patient.firstName,
      patientLastName: patient.lastName,
    }),
  );

  return (
    <div>
      <PageHeader
        title="Rendez-vous"
        description={formatDate(selectedDate)}
        actions={
          <>
            <AppointmentDatePicker schedule={schedule} />
            <Link
              href="/appointments/new"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
            >
              + Nouveau RDV
            </Link>
          </>
        }
      />

      <ViewToggle
        options={[
          { label: "Liste", value: "list" },
          { label: "Agenda", value: "agenda" },
        ]}
      />

      <AppointmentTable data={rows} />
    </div>
  );
}
