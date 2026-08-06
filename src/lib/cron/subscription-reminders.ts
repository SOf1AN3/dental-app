import { db } from "@/lib/db/db";
import { clinicSubscriptions, notifications } from "@/lib/db/schema";
import { and, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

export type SubscriptionReminderCandidate = {
  id: string;
  clinicId: string;
  endDate: Date | null;
  status: string;
};

export function selectSubscriptionsDueForReminder(
  subs: SubscriptionReminderCandidate[],
  now: Date,
  daysBefore: number,
): SubscriptionReminderCandidate[] {
  const deadline = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);
  return subs.filter(
    (sub) =>
      sub.status === "active" &&
      sub.endDate != null &&
      sub.endDate > now &&
      sub.endDate <= deadline,
  );
}

function reminderRefKey(subscriptionId: string, endDate: Date): string {
  return `sub:${subscriptionId}:${endDate.toISOString().slice(0, 10)}`;
}

export async function sendSubscriptionReminders(): Promise<{ remindersCreated: number }> {
  try {
    const now = new Date();
    const deadline = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const subs = await db
      .select({
        id: clinicSubscriptions.id,
        clinicId: clinicSubscriptions.clinicId,
        endDate: clinicSubscriptions.endDate,
        status: clinicSubscriptions.status,
      })
      .from(clinicSubscriptions)
      .where(
        and(
          eq(clinicSubscriptions.status, "active"),
          isNotNull(clinicSubscriptions.endDate),
          gt(clinicSubscriptions.endDate, now),
          lte(clinicSubscriptions.endDate, deadline),
        ),
      );

    const due = selectSubscriptionsDueForReminder(subs, now, 30);

    if (due.length === 0) {
      return { remindersCreated: 0 };
    }

    const refKeys = due.map((sub) => reminderRefKey(sub.id, sub.endDate!));

    let existing = new Set<string>();
    if (refKeys.length > 0) {
      const rows = await db
        .select({ refKey: notifications.refKey })
        .from(notifications)
        .where(inArray(notifications.refKey, refKeys));

      existing = new Set(rows.map((row) => row.refKey).filter((key): key is string => key != null));
    }

    const toCreate = due.filter((sub) => !existing.has(reminderRefKey(sub.id, sub.endDate!)));

    if (toCreate.length > 0) {
      await db.insert(notifications).values(
        toCreate.map((sub) => ({
          clinicId: sub.clinicId,
          category: "subscription_reminder" as const,
          title: "Expiration de l'abonnement",
          message: `Votre abonnement expire le ${format(sub.endDate!, "dd/MM/yyyy", { locale: fr })}.`,
          link: "/settings/subscription",
          refKey: reminderRefKey(sub.id, sub.endDate!),
        })),
      );
    }

    return { remindersCreated: toCreate.length };
  } catch {
    return { remindersCreated: 0 };
  }
}
