import { requirePlatformOwner } from "@/lib/auth-utils";
import { db } from "@/lib/db/db";
import { clinics } from "@/lib/db/schema";
import { asc, isNull } from "drizzle-orm";
import { NotificationForm } from "./notification-form";

export default async function OwnerNotificationsPage() {
  await requirePlatformOwner();

  let clinicList: { id: string; name: string }[] = [];
  try {
    clinicList = await db
      .select({ id: clinics.id, name: clinics.name })
      .from(clinics)
      .where(isNull(clinics.deletedAt))
      .orderBy(asc(clinics.name));
  } catch {
    clinicList = [];
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Notifications</h1>
        <p className="text-sm text-cool-500">Envoyer une notification aux cliniques</p>
      </div>

      <div className="mb-8 rounded-xl border border-cool-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-cool-900 mb-4">Nouvelle notification</h2>
        <NotificationForm clinics={clinicList} />
      </div>
    </div>
  );
}
