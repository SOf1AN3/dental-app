"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Return the Monday (00:00) of the week containing `date`. */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Format as local YYYY-MM-DD (avoids UTC offset shift from toISOString). */
function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function AgendaNav() {
  const searchParams = useSearchParams();
  const weekParam = searchParams.get("week");

  // Current displayed Monday
  const currentMonday = weekParam
    ? getMonday(new Date(weekParam))
    : getMonday(new Date());

  // Previous / next Monday
  const prevMonday = new Date(currentMonday);
  prevMonday.setDate(prevMonday.getDate() - 7);

  const nextMonday = new Date(currentMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  // Is this the current week?
  const todayMonday = getMonday(new Date());
  const isCurrentWeek = currentMonday.getTime() === todayMonday.getTime();

  return (
    <div className="flex items-center gap-1.5">
      {/* Previous week */}
      <Link
        href={`/appointments/agenda?week=${localDateString(prevMonday)}`}
        className="rounded-lg border border-cool-200 bg-white dark:bg-cool-100 p-2 text-cool-600 hover:bg-cool-50 transition-colors"
        aria-label="Semaine précédente"
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>

      {/* "Cette semaine" – only shown when not on current week */}
      {!isCurrentWeek && (
        <Link
          href="/appointments/agenda"
          className="rounded-lg border border-cool-200 bg-white dark:bg-cool-100 px-3 py-2 text-xs font-medium text-cool-600 hover:bg-cool-50 transition-colors whitespace-nowrap"
        >
          Cette semaine
        </Link>
      )}

      {/* Next week */}
      <Link
        href={`/appointments/agenda?week=${localDateString(nextMonday)}`}
        className="rounded-lg border border-cool-200 bg-white dark:bg-cool-100 p-2 text-cool-600 hover:bg-cool-50 transition-colors"
        aria-label="Semaine suivante"
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
