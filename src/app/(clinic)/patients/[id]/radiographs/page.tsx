import Link from "next/link";
import { notFound } from "next/navigation";
import { FileX, Download } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getRadiographs } from "@/lib/actions/clinical";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { RadiographForm } from "@/components/clinic/radiograph-form";
import { RadiographDeleteButton } from "./radiograph-delete-button";
import { resolveStoredUrl } from "@/lib/storage";

function isImageKey(key: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(key);
}

export default async function RadiographsPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const radiographs = await getRadiographs(id);

  const items = await Promise.all(
    radiographs.map(async (radio) => ({
      ...radio,
      url: await resolveStoredUrl(radio.fileKey),
    })),
  );

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
          title={`Radiographies — ${patient.lastName} ${patient.firstName}`}
        />
      </div>

      <div className="space-y-6">
        <div className="max-w-lg">
          <RadiographForm patientId={id} />
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-border-card bg-card p-12 text-center">
            <p className="text-sm text-muted-fg">Aucune radiographie</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((radio) => (
              <div
                key={radio.id}
                className="rounded-xl border border-border-card bg-card p-5"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg" aria-hidden="true">📷</span>
                  {radio.url ? (
                    isImageKey(radio.fileKey) ? (
                      <a
                        href={radio.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 / local upload URLs */}
                        <img
                          src={radio.url}
                          alt="Radiographie"
                          className="h-24 w-full rounded-lg border border-border-card bg-muted object-contain"
                        />
                      </a>
                    ) : (
                      <a
                        href={radio.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-cerulean/10 px-3 py-1.5 text-sm font-medium text-cerulean hover:bg-cerulean/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Voir le fichier
                      </a>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-fg">
                      <FileX className="h-4 w-4" aria-hidden="true" />
                      Fichier introuvable
                    </span>
                  )}
                </div>
                <dl className="space-y-1.5 text-sm">
                  {radio.fileType && (
                    <div className="flex justify-between">
                      <dt className="text-muted-fg">Type</dt>
                      <dd className="text-foreground">{radio.fileType}</dd>
                    </div>
                  )}
                  {radio.toothNumber != null && (
                    <div className="flex justify-between">
                      <dt className="text-muted-fg">Dent</dt>
                      <dd className="text-foreground">{radio.toothNumber}</dd>
                    </div>
                  )}
                  {radio.region && (
                    <div className="flex justify-between">
                      <dt className="text-muted-fg">Région</dt>
                      <dd className="text-foreground">{radio.region}</dd>
                    </div>
                  )}
                  {radio.notes && (
                    <div className="flex justify-between">
                      <dt className="text-muted-fg">Notes</dt>
                      <dd className="text-foreground text-right max-w-[60%]">
                        {radio.notes}
                      </dd>
                    </div>
                  )}
                  {radio.takenAt && (
                    <div className="flex justify-between">
                      <dt className="text-muted-fg">Pris le</dt>
                      <dd className="text-foreground">
                        {formatDate(radio.takenAt)}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-muted-fg">Ajouté le</dt>
                    <dd className="text-foreground">
                      {formatDate(radio.createdAt)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex justify-end border-t border-border-card pt-3">
                  <RadiographDeleteButton radiographId={radio.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
