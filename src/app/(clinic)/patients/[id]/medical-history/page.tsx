import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getMedicalHistory } from "@/lib/actions/clinical";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { MedicalHistoryForm } from "./medical-history-form";

export default async function MedicalHistoryPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const entries = await getMedicalHistory(id);

  return (
    <div>
      <div>
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier
        </Link>
        <PageHeader
          title={`Antécédents médicaux — ${patient.lastName} ${patient.firstName}`}
        />
      </div>

      <div className="max-w-2xl space-y-6">
        <MedicalHistoryForm patientId={id} />

        {entries.length === 0 ? (
          <div className="rounded-xl border border-border-card bg-card p-12 text-center">
            <p className="text-sm text-muted-fg">
              Aucun antécédent médical
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl border border-border-card bg-card p-5"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-base font-semibold text-foreground">
                    {entry.condition}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      entry.isActive
                        ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400 ring-1 ring-inset ring-green-600/20"
                        : "bg-cool-50 text-muted-fg ring-1 ring-inset ring-border-card"
                    }`}
                  >
                    {entry.isActive ? "Actif" : "Inactif"}
                  </span>
                </div>

                <div className="space-y-1 text-sm text-foreground">
                  {entry.diagnosisDate && (
                    <p>
                      <span className="font-medium text-muted-fg">
                        Diagnostiqué le :{" "}
                      </span>
                      {formatDate(entry.diagnosisDate)}
                    </p>
                  )}
                </div>

                {entry.notes && (
                  <p className="mt-2 text-sm text-foreground whitespace-pre-wrap">
                    {entry.notes}
                  </p>
                )}

                <div className="mt-3 text-xs text-muted-fg">
                  Ajouté le {formatDate(entry.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
