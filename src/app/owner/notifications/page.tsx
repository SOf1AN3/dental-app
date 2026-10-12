import { requirePlatformOwner } from "@/lib/auth-utils";
import { db } from "@/lib/db/db";
import { clinics } from "@/lib/db/schema";
import { asc, isNull } from "drizzle-orm";

import { PageHeader } from "@/components/ui/page-header";
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
      <PageHeader
        title="Notifications"
        description="Envoyer une notification aux cliniques"
      />

      <div className="mb-8 rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-foreground">
          Nouvelle notification
        </h2>
        <NotificationForm clinics={clinicList} />
      </div>
    </div>
  );
}
