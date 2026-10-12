import { getWaitingRoom } from "@/lib/actions/waiting-room";
import { WaitingRoomClient } from "@/components/clinic/waiting-room-client";
import { UrgenceAdmission } from "@/components/clinic/urgence-admission";
import { PageHeader } from "@/components/ui/page-header";

export default async function WaitingRoomPage() {
  // getWaitingRoom() fait déjà `requireAuth` + garde d'accès clinique et lit
  // les 3 statuts ACTIFS (`waiting | called | in_treatment`), exactement ceux
  // de l'unicité `uq_waiting_room_active_patient_clinic` — un patient appelé ou
  // en soin reste visible au lieu de disparaître tout en bloquant son ré-ajout.
  const entries = await getWaitingRoom();

  return (
    <div>
      <PageHeader title="Salle d'attente" />

      <div className="mb-6">
        <UrgenceAdmission />
      </div>

      <WaitingRoomClient initialEntries={entries} />
    </div>
  );
}
