import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getRadiographs } from "@/lib/actions/clinical";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { RadiographForm } from "@/components/clinic/radiograph-form";
import { RadiographDeleteButton } from "./radiograph-delete-button";
import { resolveStoredUrl } from "@/lib/storage";
import { FileX, Download } from "lucide-react";

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
      <div className="mb-6">
        <Link
          href={`/patients/${id}`}
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour au dossier
        </Link>
        <h1 className="text-2xl font-bold text-cool-900">
          Radiographies — {patient.lastName} {patient.firstName}
        </h1>
      </div>

      <div className="space-y-6">
        <div className="max-w-lg">
          <RadiographForm patientId={id} />
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-cool-200 bg-white p-12 text-center">
            <p className="text-sm text-cool-400">Aucune radiographie</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((radio) => (
              <div
                key={radio.id}
                className="rounded-xl border border-cool-200 bg-white p-5"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">📷</span>
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
                          className="h-24 w-full rounded-lg border border-cool-200 bg-cool-50 object-contain"
                        />
                      </a>
                    ) : (
                      <a
                        href={radio.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-cerulean/10 px-3 py-1.5 text-sm font-medium text-cerulean hover:bg-cerulean/20 transition-colors"
                      >
                        <Download className="h-4 w-4" />
                        Voir le fichier
                      </a>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-cool-400">
                      <FileX className="h-4 w-4" />
                      Fichier introuvable
                    </span>
                  )}
                </div>
                <dl className="space-y-1.5 text-sm">
                  {radio.fileType && (
                    <div className="flex justify-between">
                      <dt className="text-cool-400">Type</dt>
                      <dd className="text-cool-700">{radio.fileType}</dd>
                    </div>
                  )}
                  {radio.toothNumber != null && (
                    <div className="flex justify-between">
                      <dt className="text-cool-400">Dent</dt>
                      <dd className="text-cool-700">{radio.toothNumber}</dd>
                    </div>
                  )}
                  {radio.region && (
                    <div className="flex justify-between">
                      <dt className="text-cool-400">Région</dt>
                      <dd className="text-cool-700">{radio.region}</dd>
                    </div>
                  )}
                  {radio.notes && (
                    <div className="flex justify-between">
                      <dt className="text-cool-400">Notes</dt>
                      <dd className="text-cool-700 text-right max-w-[60%]">
                        {radio.notes}
                      </dd>
                    </div>
                  )}
                  {radio.takenAt && (
                    <div className="flex justify-between">
                      <dt className="text-cool-400">Pris le</dt>
                      <dd className="text-cool-700">
                        {formatDate(radio.takenAt)}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-cool-400">Ajouté le</dt>
                    <dd className="text-cool-700">
                      {formatDate(radio.createdAt)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex justify-end border-t border-cool-100 pt-3">
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
