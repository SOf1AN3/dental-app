import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId, requireClinicAccess } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { clinics, clinicMemberships, users } from "@/lib/db/schema";
import { eq, and, asc, inArray } from "drizzle-orm";
import { PRACTITIONER_ROLES } from "@/lib/constants";
import { getClinicScheduleMap } from "@/lib/clinic-schedule";
import { ScheduleForm } from "./schedule-form";

export default async function ScheduleSettingsPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { membership } = await requireClinicAccess(clinicId);

  const [clinic, dentists, scheduleMap] = await Promise.all([
    db.query.clinics.findFirst({ where: eq(clinics.id, clinicId) }),
    db
      .select({
        userId: clinicMemberships.userId,
        name: users.name,
        minGapMinutes: clinicMemberships.minGapMinutes,
        role: clinicMemberships.role,
      })
      .from(clinicMemberships)
      .innerJoin(users, eq(clinicMemberships.userId, users.id))
      .where(
        and(
          eq(clinicMemberships.clinicId, clinicId),
          inArray(clinicMemberships.role, PRACTITIONER_ROLES),
        ),
      )
      .orderBy(asc(users.name)),
    getClinicScheduleMap(clinicId),
  ]);

  if (!clinic) {
    return (
      <p className="text-sm text-destructive">
        Clinique introuvable.
      </p>
    );
  }

  const schedule = Array.from({ length: 7 }, (_, i) => {
    const e = scheduleMap[i];
    return {
      dayOfWeek: i,
      openTime: e?.openTime ?? clinic.openingTime,
      closeTime: e?.closeTime ?? clinic.closingTime,
      isClosed: e?.isClosed ?? false,
      isWeekend: e?.isWeekend ?? false,
    };
  });

  return (
    <div className="space-y-8">
      <ScheduleForm
        schedule={schedule}
        dentists={dentists}
        canEdit={membership.role === "owner"}
      />
    </div>
  );
}
