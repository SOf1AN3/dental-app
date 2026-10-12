import { requirePlatformOwner } from "@/lib/auth-utils";
import { db } from "@/lib/db/db";
import { sql } from "drizzle-orm";
import { HeartPulse } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";

export default async function OwnerHealthPage() {
  await requirePlatformOwner();

  let dbStatus = "OK";
  let dbError: string | null = null;
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    dbStatus = "ERROR";
    dbError = err instanceof Error ? err.message : "Erreur inconnue";
  }

  return (
    <div>
      <PageHeader title="Monitoring" description="État de la plateforme" />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-border-card bg-card p-6">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-3 ${dbStatus === "OK" ? "bg-mint/10" : "bg-danger/10"}`}>
              <HeartPulse
                aria-hidden="true"
                className={`h-6 w-6 ${dbStatus === "OK" ? "text-mint" : "text-danger"}`}
              />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Base de données</h2>
              <p className={`text-sm ${dbStatus === "OK" ? "text-mint" : "text-danger"}`}>
                {dbStatus === "OK" ? "Connecté" : `Erreur: ${dbError}`}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border-card bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">Version</h2>
          <p className="mt-2 text-sm text-muted-fg">
            DentalCare v0.1.0 · Next.js 16 · PostgreSQL
          </p>
        </div>
      </div>
    </div>
  );
}
