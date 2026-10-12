import { db } from "@/lib/db/db";
import { patients, users, clinicMemberships, appointments, clinics } from "@/lib/db/schema";
import { eq, and, asc, inArray } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { PRACTITIONER_ROLES } from "@/lib/constants";
import { getClinicScheduleDays } from "@/lib/clinic-schedule";
import { redirect } from "next/navigation";
import { AppointmentForm } from "@/components/clinic/appointment-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function EditAppointmentPage(props: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });

  const schedule = await getClinicScheduleDays(clinicId, clinic?.openingTime ?? "08:00", clinic?.closingTime ?? "19:00");

  const appointment = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.clinicId, clinicId)),
  });

  if (!appointment || (appointment.status !== "scheduled" && appointment.status !== "confirmed")) {
    redirect("/appointments");
  }

  const patientList = await db
    .select()
    .from(patients)
    .where(eq(patients.clinicId, clinicId))
    .orderBy(asc(patients.lastName));

  const dentists = await db
    .select({ id: users.id, name: users.name, role: clinicMemberships.role })
    .from(clinicMemberships)
    .innerJoin(users, eq(clinicMemberships.userId, users.id))
    .where(and(
      eq(clinicMemberships.clinicId, clinicId),
      inArray(clinicMemberships.role, PRACTITIONER_ROLES),
    ))
    .orderBy(users.name);

  return (
    <div>
      <PageHeader
        title="Modifier le rendez-vous"
        description="Mettre à jour les informations du rendez-vous"
      />
      <AppointmentForm
        patients={patientList}
        dentists={dentists}
        currentUserId={user.id}
        timezone={clinic?.timezone ?? "Africa/Algiers"}
        schedule={schedule}
        appointment={appointment}
      />
    </div>
  );
}
