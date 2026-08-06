import { requirePlatformOwner } from "@/lib/auth-utils";
import { db } from "@/lib/db/db";
import { sql } from "drizzle-orm";
import { HeartPulse } from "lucide-react";

export default async function OwnerHealthPage() {
  await requirePlatformOwner();

  let dbStatus = "OK";
  let dbError: string | null = null;
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    dbStatus = "ERROR";
    dbError = (err as Error).message;
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Monitoring</h1>
        <p className="text-sm text-cool-500">État de la plateforme</p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-cool-200 bg-white p-6">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-3 ${dbStatus === "OK" ? "bg-mint/10" : "bg-danger/10"}`}>
              <HeartPulse className={`h-6 w-6 ${dbStatus === "OK" ? "text-mint" : "text-danger"}`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cool-900">Base de données</h2>
              <p className={`text-sm ${dbStatus === "OK" ? "text-mint" : "text-danger"}`}>
                {dbStatus === "OK" ? "Connecté" : `Erreur: ${dbError}`}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-cool-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-cool-900">Version</h2>
          <p className="mt-2 text-sm text-cool-500">
            DentalCare v0.1.0 · Next.js 16 · PostgreSQL
          </p>
        </div>
      </div>
    </div>
  );
}
