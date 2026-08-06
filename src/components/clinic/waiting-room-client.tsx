"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { updateWaitingStatus } from "@/lib/actions/waiting-room";
import { callPatientFromWaitingRoom } from "@/lib/actions/session";
import { RefreshCw } from "lucide-react";

interface WaitingEntry {
  entry: {
    id: string;
    status: string;
    arrivedAt: Date;
    patientId: string;
    notes: string | null;
  };
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
}

interface WaitingRoomClientProps {
  initialEntries: WaitingEntry[];
}

export function WaitingRoomClient({ initialEntries }: WaitingRoomClientProps) {
  const router = useRouter();
  const [lastRefreshed, setLastRefreshed] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    router.refresh();
    setLastRefreshed(new Date());
    setTimeout(() => setRefreshing(false), 500);
  }, [router]);

  useEffect(() => {
    const interval = setInterval(
      refresh,
      initialEntries.length > 0 ? 5000 : 15000
    );
    return () => clearInterval(interval);
  }, [refresh, initialEntries.length]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-cool-500">
          {initialEntries.length} patient(s) en attente
        </p>
        <div className="flex items-center gap-3">
          <span className="text-xs text-cool-400">
            Dernière màj: {lastRefreshed.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cool-200 px-3 py-1.5 text-sm text-cool-600 hover:bg-cool-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Rafraîchir
          </button>
        </div>
      </div>

      {initialEntries.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-cool-200 bg-white p-12 text-center">
          <p className="text-lg font-medium text-cool-500">Salle d&apos;attente vide</p>
          <p className="text-sm text-cool-400 mt-1">Aucun patient en attente</p>
        </div>
      )}

      {initialEntries.map(({ entry, patient }) => (
        <div
          key={entry.id}
          className="flex items-center justify-between rounded-xl border border-cool-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cerulean/10 text-cerulean font-semibold text-sm">
              {patient.firstName[0]}{patient.lastName[0]}
            </div>
            <div>
              <p className="font-medium text-cool-900">
                {patient.lastName} {patient.firstName}
              </p>
              <p className="text-xs text-cool-400">
                Arrivé à {new Date(entry.arrivedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                {patient.phone && ` · ${patient.phone}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <form action={async () => { await callPatientFromWaitingRoom(entry.id); }}>
              <button
                type="submit"
                className="rounded-lg bg-cerulean px-3 py-1.5 text-sm font-medium text-white hover:bg-cerulean/90 transition-colors"
              >
                Appeler
              </button>
            </form>
            <form action={async () => { await updateWaitingStatus(entry.id, "no_show"); refresh(); }}>
              <button
                type="submit"
                className="rounded-lg border border-danger/20 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/5 transition-colors"
              >
                Absent
              </button>
            </form>
          </div>
        </div>
      ))}

      <div className="rounded-lg bg-cool-50 p-3 text-center text-xs text-cool-400">
        Mise à jour automatique toutes les {initialEntries.length > 0 ? "5" : "15"} secondes
      </div>
    </div>
  );
}
