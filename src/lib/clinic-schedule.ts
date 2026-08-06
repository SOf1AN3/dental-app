import "server-only"
import { db } from "@/lib/db/db"
import { clinicSchedule } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import type { ClinicDayInfo, ClinicScheduleEntry } from "@/lib/appointment-rules"

export type ClinicScheduleMap = Partial<Record<number, ClinicScheduleEntry>>

export async function getClinicScheduleMap(clinicId: string): Promise<ClinicScheduleMap> {
  const rows = await db
    .select({
      dayOfWeek: clinicSchedule.dayOfWeek,
      openTime: clinicSchedule.openTime,
      closeTime: clinicSchedule.closeTime,
      isClosed: clinicSchedule.isClosed,
      isWeekend: clinicSchedule.isWeekend,
    })
    .from(clinicSchedule)
    .where(eq(clinicSchedule.clinicId, clinicId))
  const map: ClinicScheduleMap = {}
  for (const row of rows) {
    map[row.dayOfWeek] = {
      openTime: row.openTime,
      closeTime: row.closeTime,
      isClosed: row.isClosed,
      isWeekend: row.isWeekend,
    }
  }
  return map
}

export async function getClinicScheduleDays(
  clinicId: string,
  fallbackOpen: string,
  fallbackClose: string,
): Promise<ClinicDayInfo[]> {
  const map = await getClinicScheduleMap(clinicId)
  return Array.from({ length: 7 }, (_, i) => {
    const e = map[i]
    return {
      dayOfWeek: i,
      openTime: e?.openTime ?? fallbackOpen,
      closeTime: e?.closeTime ?? fallbackClose,
      isClosed: e?.isClosed ?? false,
      isWeekend: e?.isWeekend ?? false,
    }
  })
}
