"use client";

import { useActionState, useEffect, useState, useSyncExternalStore } from "react";
import {
  createAppointment,
  getAvailableSlots,
  updateAppointment,
} from "@/lib/actions/appointment";
import { APPOINTMENT_TYPES } from "@/lib/constants";
import { dayOfWeekIndexForClinicDate, utcDateString } from "@/lib/appointment-rules"
import type { ClinicDayInfo } from "@/lib/appointment-rules"
import { ScheduleDatePicker } from "./schedule-date-picker"

interface AppointmentFormProps {
  patients: Array<{ id: string; firstName: string; lastName: string }>;
  dentists: Array<{ id: string; name: string | null; role?: string }>;
  currentUserId?: string;
  preselectedPatientId?: string;
  timezone?: string;
  schedule: ClinicDayInfo[];
  appointment?: {
    id: string;
    patientId: string;
    dentistId: string | null;
    startTime: Date;
    endTime: Date;
    type: string | null;
    notes: string | null;
  } | null;
}

function formatSlotTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function subscribe() {
  return () => {};
}

export function AppointmentForm({
  patients,
  dentists,
  currentUserId,
  preselectedPatientId,
  timezone = "Africa/Algiers",
  schedule,
  appointment,
}: AppointmentFormProps) {
  const isEditing = Boolean(appointment);
  const [state, action, pending] = useActionState(
    isEditing && appointment
      ? updateAppointment.bind(null, appointment.id)
      : createAppointment,
    undefined,
  );

  const [patientId, setPatientId] = useState(
    preselectedPatientId || appointment?.patientId || "",
  );
  const [dentistId, setDentistId] = useState(
    appointment?.dentistId ||
      (currentUserId && dentists.some((d) => d.id === currentUserId) ? currentUserId : ""),
  );
  const [date, setDate] = useState(
    appointment ? utcDateString(appointment.startTime) : "",
  );
  const [slot, setSlot] = useState(
    appointment ? appointment.startTime.toISOString() : "",
  );
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const today = useSyncExternalStore(
    subscribe,
    () => new Date().toISOString().slice(0, 10),
    () => "",
  );
  const effectiveDate = date || today;

  const excludeId = appointment?.id;

  useEffect(() => {
    if (!effectiveDate || !patientId) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoadingSlots(true);
      try {
        const result = await getAvailableSlots(effectiveDate, dentistId || null, patientId, excludeId);
        if (cancelled) return;
        setSlots(result.slots);
      } catch {
        if (!cancelled) setSlots([]);
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveDate, dentistId, patientId, excludeId]);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? (state.error as Record<string, string[] | undefined>).general?.[0]
      : undefined;

  const conflict = state && "conflict" in state && state.conflict ? state.conflict : undefined;

  const appointmentStartIso = appointment ? appointment.startTime.toISOString() : null;
  const showCurrentSlot =
    appointment != null &&
    appointmentStartIso !== null &&
    effectiveDate === utcDateString(appointment.startTime) &&
    !slots.includes(appointmentStartIso);
  const displaySlots =
    showCurrentSlot && appointmentStartIso ? [appointmentStartIso, ...slots] : slots;

  const endIso = slot
    ? appointment && slot === appointmentStartIso
      ? appointment.endTime.toISOString()
      : new Date(new Date(slot).getTime() + 30 * 60 * 1000).toISOString()
    : "";

  return (
    <form action={action} className="max-w-xl space-y-6">
      <div className="rounded-xl border border-cool-200 bg-white p-6 space-y-4">
        {generalError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {generalError}
            {conflict && (
              <div className="mt-1">
                Conflit avec {conflict.patientName} du {new Date(conflict.startTime).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} au {new Date(conflict.endTime).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
                {conflict.dentistName ? ` (${conflict.dentistName})` : ""}
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor="patientId" className="block text-sm font-medium text-cool-700">Patient *</label>
          <select
            id="patientId" name="patientId" required
            value={patientId}
            onChange={(e) => {
              setPatientId(e.target.value);
              setSlot("");
              setSlots([]);
            }}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          >
            <option value="">Sélectionner un patient</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.lastName} {p.firstName}</option>
            ))}
          </select>
          {fieldErrors?.patientId && <p className="mt-1 text-xs text-red-500">{fieldErrors.patientId[0]}</p>}
        </div>

        <div>
          <label htmlFor="dentistId" className="block text-sm font-medium text-cool-700">Praticien</label>
          <select
            id="dentistId" name="dentistId"
            value={dentistId}
            onChange={(e) => {
              setDentistId(e.target.value);
              setSlot("");
              setSlots([]);
            }}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          >
            <option value="">— Aucun praticien —</option>
            {dentists.map((d) => (
              <option key={d.id} value={d.id}>{d.name || "—"}{d.role === "owner" ? " (Propriétaire)" : ""}</option>
            ))}
          </select>
          {fieldErrors?.dentistId && <p className="mt-1 text-xs text-red-500">{fieldErrors.dentistId[0]}</p>}
        </div>

        <div>
          <label htmlFor="date" className="block text-sm font-medium text-cool-700">Date *</label>
          <ScheduleDatePicker
            id="date"
            ariaLabel="Date"
            value={effectiveDate}
            onChange={(d) => {
              setDate(d);
              setSlot("");
              setSlots([]);
            }}
            schedule={schedule}
            timezone={timezone}
          />
          <input type="hidden" name="date" value={effectiveDate} />
          {effectiveDate &&
            schedule[dayOfWeekIndexForClinicDate(effectiveDate, timezone)]?.isClosed && (
              <p className="mt-1 text-xs text-amber-600">La clinique est fermée ce jour-là</p>
            )}
        </div>

        <div>
          <label htmlFor="startTime" className="block text-sm font-medium text-cool-700">Début *</label>
          <div className="mt-1">
            {loadingSlots ? (
              <p className="text-xs text-cool-500">Chargement des créneaux...</p>
            ) : displaySlots.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {displaySlots.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSlot(s)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                      slot === s
                        ? "border-cerulean bg-cerulean text-white"
                        : "border-cool-200 bg-white text-cool-700 hover:bg-cool-50"
                    }`}
                  >
                    {formatSlotTime(s, timezone)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-cool-400">Aucun créneau disponible pour cette sélection</p>
            )}
          </div>
          {fieldErrors?.startTime && <p className="mt-1 text-xs text-red-500">{fieldErrors.startTime[0]}</p>}
        </div>

        <input type="hidden" name="startTime" value={slot} />
        <input type="hidden" name="endTime" value={endIso} />

        <div>
          <label htmlFor="type" className="block text-sm font-medium text-cool-700">Type</label>
          <select
            id="type" name="type"
            defaultValue={appointment?.type || ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          >
            <option value="">Sélectionner un type</option>
            {APPOINTMENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-cool-700">Notes</label>
          <textarea
            id="notes" name="notes" rows={3}
            defaultValue={appointment?.notes || ""}
            className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending
            ? (isEditing ? "Enregistrement..." : "Création...")
            : (isEditing ? "Enregistrer les modifications" : "Créer le rendez-vous")}
        </button>
        <a
          href="/appointments"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </a>
      </div>
    </form>
  );
}
