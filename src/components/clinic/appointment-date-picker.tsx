"use client"

import { useRouter, useSearchParams } from "next/navigation"
import type { ClinicDayInfo } from "@/lib/appointment-rules"
import { ScheduleDatePicker } from "./schedule-date-picker"

interface AppointmentDatePickerProps {
  schedule: ClinicDayInfo[]
}

export function AppointmentDatePicker({ schedule }: AppointmentDatePickerProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  return (
    <ScheduleDatePicker
      value={searchParams.get("date") || new Date().toISOString().split("T")[0]}
      onChange={(iso) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set("date", iso)
        router.replace(`/appointments?${params.toString()}`)
      }}
      schedule={schedule}
    />
  )
}
