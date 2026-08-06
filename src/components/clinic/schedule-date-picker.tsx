"use client"

import { useEffect, useRef, useState } from "react"
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns"
import { fr } from "date-fns/locale"
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react"
import type { ClinicDayInfo } from "@/lib/appointment-rules"
import { dayOfWeekIndexForClinicDate } from "@/lib/appointment-rules"

interface ScheduleDatePickerProps {
  value: string
  onChange: (iso: string) => void
  schedule: ClinicDayInfo[]
  timezone?: string
  id?: string
  ariaLabel?: string
}

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function ScheduleDatePicker({
  value,
  onChange,
  schedule,
  timezone = "Africa/Algiers",
  id,
  ariaLabel,
}: ScheduleDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [viewDate, setViewDate] = useState(() =>
    value ? new Date(value + "T12:00:00") : new Date(),
  )
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(viewDate), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(viewDate), { weekStartsOn: 1 }),
  })

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          setViewDate(value ? new Date(value + "T12:00:00") : new Date())
          setOpen(true)
        }}
        className="flex w-full items-center justify-between rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean"
      >
        <span className={value ? "text-cool-700" : "text-cool-400"}>
          {value
            ? capitalize(format(new Date(value + "T12:00:00"), "EEE d MMM yyyy", { locale: fr }))
            : "Sélectionner une date"}
        </span>
        <CalendarIcon className="h-4 w-4 text-cool-400" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-cool-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Mois précédent"
              onClick={() => setViewDate(addMonths(viewDate, -1))}
              className="rounded-md p-1 text-cool-500 hover:bg-cool-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-cool-800">
              {capitalize(format(viewDate, "MMMM yyyy", { locale: fr }))}
            </span>
            <button
              type="button"
              aria-label="Mois suivant"
              onClick={() => setViewDate(addMonths(viewDate, 1))}
              className="rounded-md p-1 text-cool-500 hover:bg-cool-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((label) => (
              <div key={label} className="text-center text-[11px] font-medium uppercase text-cool-400">
                {label}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {days.map((day) => {
              if (!isSameMonth(day, viewDate)) return <div key={day.toISOString()} />
              const iso = isoFromDate(day)
              const info = schedule[dayOfWeekIndexForClinicDate(iso, timezone)]
              const isClosed = info?.isClosed === true
              const selected = value === iso
              const disabled = isClosed && !selected
              const isToday = isSameDay(day, new Date())
              const cellClass = [
                "relative mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-sm transition-colors",
                selected
                  ? "bg-cerulean font-semibold text-white"
                  : disabled
                    ? "cursor-not-allowed text-cool-300"
                    : "text-cool-700 hover:bg-cool-100",
                isToday && !selected ? "ring-1 ring-inset ring-cerulean/40" : "",
              ].join(" ")
              const title = isClosed
                ? "Clinique fermée"
                : `Ouvert (${info?.openTime?.slice(0, 5) ?? ""} – ${info?.closeTime?.slice(0, 5) ?? ""})${info?.isWeekend ? " · Week-end" : ""}`
              return (
                <button
                  key={iso}
                  type="button"
                  title={title}
                  aria-disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    onChange(iso)
                    setOpen(false)
                  }}
                  className={cellClass}
                >
                  {format(day, "d")}
                  {info?.isWeekend && (
                    <span className={"absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full " + (selected ? "bg-white" : "bg-amber-400")} />
                  )}
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-4 border-t border-cool-100 pt-2 text-xs text-cool-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-cool-200" />
              Fermé
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
              Week-end
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
