import { db } from "@/lib/db/db";
import { appointments, patients, clinics } from "@/lib/db/schema";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { getClinicScheduleDays } from "@/lib/clinic-schedule";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { StatusBadge } from "@/components/shared/status-badge";
import { AppointmentActions } from "@/components/clinic/appointment-actions";
import { AppointmentDatePicker } from "@/components/clinic/appointment-date-picker";
import { ViewToggle } from "@/components/clinic/view-toggle";

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

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Rendez-vous</h1>
          <p className="text-sm text-cool-500">{formatDate(selectedDate)}</p>
        </div>
        <div className="flex items-center gap-3">
          <AppointmentDatePicker schedule={schedule} />
          <Link
            href="/appointments/new"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
          >
            + Nouveau RDV
          </Link>
        </div>
      </div>

      <ViewToggle
        options={[
          { label: "Liste", value: "list" },
          { label: "Agenda", value: "agenda" },
        ]}
      />

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Horaire</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Patient</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Statut</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {appointmentList.map(({ appointment, patient }) => (
              <tr key={appointment.id} className="border-b border-cool-100 hover:bg-cool-50">
                <td className="px-4 py-3">
                  <span className="font-medium text-cool-900">
                    {new Date(appointment.startTime).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="text-cool-400 mx-1">-</span>
                  <span className="text-cool-500">
                    {new Date(appointment.endTime).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/patients/${patient.id}`} className="font-medium text-cerulean hover:text-cerulean/80">
                    {patient.lastName} {patient.firstName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-cool-600">{appointment.type || "-"}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={appointment.status} />
                </td>
                <td className="px-4 py-3">
                  <AppointmentActions appointment={appointment} />
                </td>
              </tr>
            ))}
            {appointmentList.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-cool-400">
                  Aucun rendez-vous pour cette date
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
