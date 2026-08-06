import { db } from "@/lib/db/db";
import { waitingRoomEntries, patients } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { WaitingRoomClient } from "@/components/clinic/waiting-room-client";

export default async function WaitingRoomPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const entries = await db
    .select({
      entry: waitingRoomEntries,
      patient: patients,
    })
    .from(waitingRoomEntries)
    .innerJoin(patients, eq(waitingRoomEntries.patientId, patients.id))
    .where(
      and(
        eq(waitingRoomEntries.clinicId, clinicId),
        eq(waitingRoomEntries.status, "waiting"),
      )
    )
    .orderBy(asc(waitingRoomEntries.arrivedAt));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Salle d&apos;attente</h1>
      </div>

      <WaitingRoomClient initialEntries={entries} />
    </div>
  );
}
