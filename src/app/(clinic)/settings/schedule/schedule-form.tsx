"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateClinicSchedule, updateDentistMinGap } from "@/lib/actions/settings";

interface Dentist {
  userId: string;
  name: string | null;
  minGapMinutes: number;
  role?: string;
}

interface ScheduleDay {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
  isWeekend: boolean;
}

const DAY_NAMES_FULL = [
  "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche",
];

function DentistGapForm({ dentist }: { dentist: Dentist }) {
  const [state, action, pending] = useActionState(
    updateDentistMinGap.bind(null, dentist.userId),
    undefined,
  );
  const [minutes, setMinutes] = useState(String(dentist.minGapMinutes));

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? state.error.general?.[0]
      : undefined;

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border-card px-4 py-3"
    >
      <span className="flex-1 min-w-0 text-sm font-medium text-foreground">
        {dentist.name || "Dentiste"}{dentist.role === "owner" ? " (Propriétaire)" : ""}
      </span>
      <input
        type="number"
        name="minutes"
        min={0}
        step={5}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        aria-label={`Délai minimal entre deux rendez-vous pour ${dentist.name || "ce dentiste"} (minutes)`}
        className="w-24 rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
      />
      <span className="text-sm text-muted-fg">min</span>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {pending ? "Enregistrement..." : "Enregistrer"}
      </button>
      {state?.success && <span className="text-xs text-green-600 dark:text-green-400">Enregistré</span>}
      {generalError && <p className="w-full text-xs text-destructive dark:text-red-400">{generalError}</p>}
    </form>
  );
}

const timeInputClass =
  "rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none disabled:opacity-50";

function DayRow({ day }: { day: ScheduleDay }) {
  const [open, setOpen] = useState(day.openTime.slice(0, 5));
  const [close, setClose] = useState(day.closeTime.slice(0, 5));
  const [isClosed, setIsClosed] = useState(day.isClosed);
  const [isWeekend, setIsWeekend] = useState(day.isWeekend);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-cool-100 py-3 last:border-b-0">
      <span className="w-24 text-sm font-medium text-foreground">
        {DAY_NAMES_FULL[day.dayOfWeek]}
      </span>
      <div className="flex items-center gap-2">
        <label htmlFor={`open-${day.dayOfWeek}`} className="sr-only">
          Ouverture {DAY_NAMES_FULL[day.dayOfWeek]}
        </label>
        <input
          id={`open-${day.dayOfWeek}`}
          type="time"
          name={`open-${day.dayOfWeek}`}
          value={open}
          disabled={isClosed}
          onChange={(e) => setOpen(e.target.value)}
          className={timeInputClass}
        />
        <span className="text-muted-fg">–</span>
        <label htmlFor={`close-${day.dayOfWeek}`} className="sr-only">
          Fermeture {DAY_NAMES_FULL[day.dayOfWeek]}
        </label>
        <input
          id={`close-${day.dayOfWeek}`}
          type="time"
          name={`close-${day.dayOfWeek}`}
          value={close}
          disabled={isClosed}
          onChange={(e) => setClose(e.target.value)}
          className={timeInputClass}
        />
      </div>
      <label className="flex items-center gap-1.5 text-sm text-muted-fg">
        <input
          type="checkbox"
          name={`closed-${day.dayOfWeek}`}
          checked={isClosed}
          onChange={(e) => setIsClosed(e.target.checked)}
          className="rounded border-input"
        />
        Fermé
      </label>
      <label className="flex items-center gap-1.5 text-sm text-muted-fg">
        <input
          type="checkbox"
          name={`weekend-${day.dayOfWeek}`}
          checked={isWeekend}
          onChange={(e) => setIsWeekend(e.target.checked)}
          className="rounded border-input"
        />
        Week-end
      </label>
    </div>
  );
}

export function ScheduleForm({
  schedule,
  dentists,
  canEdit,
}: {
  schedule: ScheduleDay[];
  dentists: Dentist[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(updateClinicSchedule, undefined);

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? state.error.general?.[0]
      : undefined;

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Horaires d&apos;ouverture de la clinique
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Les horaires sont définis pour chaque jour de la semaine.
        </p>
        {canEdit ? (
          <form action={action} className="space-y-4">
            <div className="divide-y divide-cool-100">
              {schedule.map((day) => (
                <DayRow key={day.dayOfWeek} day={day} />
              ))}
            </div>
            {generalError && <p className="text-sm text-destructive dark:text-red-400">{generalError}</p>}
            {state?.success && (
              <p className="text-sm text-green-600 dark:text-green-400">Horaires mis à jour.</p>
            )}
            <div className="pt-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                {pending ? "Enregistrement..." : "Enregistrer"}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2">
            {schedule.map((day) => (
              <div
                key={day.dayOfWeek}
                className="flex items-center justify-between rounded-lg border border-cool-100 px-4 py-2.5"
              >
                <span className="text-sm font-medium text-foreground">
                  {DAY_NAMES_FULL[day.dayOfWeek]}
                </span>
                <span className="text-sm text-muted-fg">
                  {day.isClosed
                    ? "Fermé"
                    : `${day.openTime.slice(0, 5)} – ${day.closeTime.slice(0, 5)}`}
                  {day.isWeekend ? " · Week-end" : ""}
                </span>
              </div>
            ))}
              <p className="pt-2 text-xs text-amber-600 dark:text-amber-400">
              Seul le propriétaire peut modifier les horaires.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Délai minimal entre deux rendez-vous
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Délai de garde entre deux rendez-vous pour chaque dentiste.
        </p>
        {dentists.length === 0 ? (
          <p className="text-sm text-muted-fg">Aucun dentiste dans la clinique.</p>
        ) : (
          <div className="space-y-3">
            {dentists.map((dentist) =>
              canEdit ? (
                <DentistGapForm key={dentist.userId} dentist={dentist} />
              ) : (
                <div
                  key={dentist.userId}
                  className="flex items-center gap-3 rounded-lg border border-border-card px-4 py-3"
                >
                  <span className="flex-1 min-w-0 text-sm font-medium text-foreground">
                    {dentist.name || "Dentiste"}{dentist.role === "owner" ? " (Propriétaire)" : ""}
                  </span>
                  <span className="text-sm text-muted-fg">
                    {dentist.minGapMinutes} min
                  </span>
                </div>
              ),
            )}
            {!canEdit && (
            <p className="pt-2 text-xs text-amber-600 dark:text-amber-400">
                Seul le propriétaire peut modifier les délais.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
