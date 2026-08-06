import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getConsultationNotes } from "@/lib/actions/clinical";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { ConsultationNoteForm } from "@/components/clinic/consultation-note-form";

export default async function ConsultationNotesPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const notes = await getConsultationNotes(id);

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
          Notes de consultation — {patient.lastName} {patient.firstName}
        </h1>
      </div>

      <div className="max-w-2xl space-y-6">
        <ConsultationNoteForm patientId={id} />

        {notes.length === 0 ? (
          <div className="rounded-xl border border-cool-200 bg-white p-12 text-center">
            <p className="text-sm text-cool-400">Aucune note de consultation</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="rounded-xl border border-cool-200 bg-white p-5"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="text-xs text-cool-400">
                    {formatDate(note.createdAt)}
                  </div>
                </div>
                {note.diagnosis && (
                  <p className="text-sm font-medium text-cool-900 mb-1">
                    <span className="text-cool-500">Diagnostic :</span>{" "}
                    {note.diagnosis}
                  </p>
                )}
                <p className="text-sm text-cool-700 whitespace-pre-wrap">
                  {note.notes}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
