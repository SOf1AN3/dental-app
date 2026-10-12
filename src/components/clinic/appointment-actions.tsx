"use client";

import Link from "next/link";
import { useTransition, useState, useSyncExternalStore } from "react";
import { updateAppointmentStatus } from "@/lib/actions/appointment";
import { addToWaitingRoom } from "@/lib/actions/waiting-room";
import { isSameClinicDate } from "@/lib/appointment-rules";

interface AppointmentActionsProps {
  appointment: {
    id: string;
    status: string;
    patientId: string;
    startTime: string | Date;
  };
}

function subscribe() {
  return () => {};
}

export function AppointmentActions({ appointment }: AppointmentActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const status = appointment.status;

  const isToday = useSyncExternalStore(
    subscribe,
    () => isSameClinicDate(new Date(appointment.startTime), new Date(), "Africa/Algiers"),
    () => false,
  );

  function handleStatusChange(newStatus: string) {
    setError(null);
    startTransition(async () => {
      await updateAppointmentStatus(appointment.id, newStatus);
    });
  }

  function handleCancel() {
    setError(null);
    if (!window.confirm("Annuler ce rendez-vous ? Cette action est irréversible.")) return;
    startTransition(async () => {
      await updateAppointmentStatus(appointment.id, "cancelled");
    });
  }

  function handleAddToWaiting() {
    setError(null);
    startTransition(async () => {
      const result = await addToWaitingRoom(appointment.id, appointment.patientId);
      if (result?.error) setError(result.error);
    });
  }

  if (status === "cancelled" || status === "completed" || status === "no_show") {
    return <span className="text-xs text-cool-400">-</span>;
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        {(status === "scheduled" || status === "confirmed") && (
          <Link
            href={`/appointments/${appointment.id}/edit`}
            className="rounded bg-cool-100 px-2 py-1 text-xs font-medium text-cool-700 hover:bg-cool-200 disabled:opacity-50"
          >
            Modifier
          </Link>
        )}
        {status === "scheduled" && (
          <button
            onClick={() => handleStatusChange("confirmed")}
            disabled={isPending}
            className="rounded bg-cerulean/10 px-2 py-1 text-xs font-medium text-cerulean hover:bg-cerulean/20 disabled:opacity-50"
          >
            Confirmer
          </button>
        )}
        {(status === "scheduled" || status === "confirmed") && (
          <button
            onClick={handleAddToWaiting}
            disabled={isPending || !isToday}
            title={isToday ? undefined : "Le patient ne peut être marqué arrivé que le jour du rendez-vous"}
            className="rounded bg-amber/10 px-2 py-1 text-xs font-medium text-amber-fg hover:bg-amber/20 disabled:opacity-50"
          >
            Arrivé
          </button>
        )}
        <button
          onClick={handleCancel}
          disabled={isPending}
          className="rounded bg-danger/10 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
        >
          Annuler
        </button>
        {status === "in_progress" && (
          <button
            onClick={() => handleStatusChange("completed")}
            disabled={isPending}
            className="rounded bg-mint/10 px-2 py-1 text-xs font-medium text-mint hover:bg-mint/20 disabled:opacity-50"
          >
            Terminer
          </button>
        )}
      </div>
      {error && (
        <p className="mt-1 text-xs font-medium text-danger">{error}</p>
      )}
    </div>
  );
}
