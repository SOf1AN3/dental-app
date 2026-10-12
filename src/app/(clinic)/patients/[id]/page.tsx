import { db } from "@/lib/db/db";
import { appointments, patients } from "@/lib/db/schema";
import { eq, and, gte, asc, notInArray } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { PatientArchiveActions } from "@/components/clinic/patient-archive-actions";
import { getActiveSession } from "@/lib/actions/session";
import { Scan, HeartPulse, ClipboardList, FileText, Camera, Pill, Calendar, CalendarPlus, Archive, Stethoscope } from "lucide-react";

export default async function PatientDossierPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { id } = await props.params;

  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, id), eq(patients.clinicId, clinicId)),
  });

  if (!patient) notFound();

  const activeSession = await getActiveSession(id);

  const upcomingAppointments = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.patientId, id),
        gte(appointments.startTime, new Date()),
        notInArray(appointments.status, ["cancelled", "completed"])
      )
    )
    .orderBy(asc(appointments.startTime));

  return (
    <div>
      <div>
        <Link
          href="/patients"
          className="text-sm text-cerulean hover:text-cerulean/80 mb-1 inline-block"
        >
          ← Retour aux patients
        </Link>
        <PageHeader
          title={`${patient.lastName} ${patient.firstName}`}
          actions={
            <>
              {patient.deletedAt ? (
                <PatientArchiveActions patientId={id} archived />
              ) : (
                <>
                  <Link
                    href={`/patients/${id}/edit`}
                    className="rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    Modifier
                  </Link>
                  {activeSession ? (
                    <Link
                      href={`/patients/${id}/session/${activeSession.id}`}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      Reprendre la séance
                    </Link>
                  ) : (
                    <Link
                      href={`/patients/${id}/session/new`}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      Nouvelle séance
                    </Link>
                  )}
                  <Link
                    href={`/appointments/new?patientId=${id}`}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    Prendre RDV
                  </Link>
                  <PatientArchiveActions patientId={id} archived={false} />
                </>
              )}
            </>
          }
        />
      </div>

      {patient.deletedAt && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/10 px-4 py-3">
          <Archive className="h-5 w-5 shrink-0 text-[#92400e] dark:text-[#fbbf24]" aria-hidden="true" />
          <p className="text-sm font-medium text-[#92400e] dark:text-[#fbbf24]">Patient archivé</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Informations
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-muted-fg">Date de naissance</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.dateOfBirth
                    ? formatDate(patient.dateOfBirth)
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Genre</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.gender || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Téléphone</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.phone || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Email</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.email || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">Adresse</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.address || "-"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Assurance
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-muted-fg">Mutuelle</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.insuranceProvider || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-fg">N° adhérent</dt>
                <dd className="text-sm font-medium text-foreground">
                  {patient.insuranceNumber || "-"}
                </dd>
              </div>
            </dl>
          </div>

          {patient.notes && (
            <div className="rounded-xl border border-border-card bg-card p-6">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
                Notes
              </h2>
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {patient.notes}
              </p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
            <div className="rounded-xl border border-border-card bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider">
                Prochains rendez-vous
              </h2>
              {!patient.deletedAt && (
                <Link
                  href={`/appointments/new?patientId=${id}`}
                  className="inline-flex items-center gap-1.5 text-sm text-cerulean hover:text-cerulean/80"
                >
                  <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                  Ajouter
                </Link>
              )}
            </div>
            {upcomingAppointments.length > 0 ? (
              <ul className="divide-y divide-border-card">
                {upcomingAppointments.map((appt) => (
                  <li key={appt.id}>
                    <Link
                      href={`/appointments?date=${appt.startTime.toISOString().split("T")[0]}`}
                      className="flex items-center gap-3 py-3 px-1 rounded-lg hover:bg-cool-50 transition-colors group"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cerulean/10 text-cerulean shrink-0">
                        <Calendar className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-cool-900 group-hover:text-cerulean transition-colors">
                            {new Date(appt.startTime).toLocaleDateString("fr-FR", {
                              day: "numeric",
                              month: "long",
                              year: "numeric",
                            })}
                          </span>
                          <span className="text-xs text-cool-400">
                            {new Date(appt.startTime).toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            {" - "}
                            {new Date(appt.endTime).toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-cool-500">
                            {appt.type || "Consultation"}
                          </span>
                          <StatusBadge
                            status={appt.status}
                            domain="appointment"
                            className="text-[10px]"
                          />
                        </div>
                      </div>
                      <span className="text-xs text-cerulean opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        Voir →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-cool-400 py-8 text-center">
                Aucun rendez-vous prévu
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border-card bg-card p-6">
            <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
              Navigation rapide
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <Link
                href={`/patients/${id}/dental-chart`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <Scan className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Odontogramme
                </p>
              </Link>
              <Link
                href={`/patients/${id}/medical-history`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <HeartPulse className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Antécédents médicaux
                </p>
              </Link>
              <Link
                href={`/patients/${id}/treatment-plan`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <ClipboardList className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Plan de traitement
                </p>
              </Link>
              <Link
                href={`/patients/${id}/consultation-notes`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <FileText className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Notes cliniques
                </p>
              </Link>
              <Link
                href={`/patients/${id}/radiographs`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <Camera className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Radiographies
                </p>
              </Link>
              <Link
                href={`/patients/${id}/prescriptions`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <Pill className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Ordonnances
                </p>
              </Link>
              <Link
                href={`/patients/${id}/sessions`}
                className="flex flex-col items-center gap-2 rounded-lg border border-cool-200 p-4 text-center hover:border-cerulean hover:bg-cerulean/5 transition-colors"
              >
                <Stethoscope className="h-6 w-6 text-cerulean" />
                <p className="text-sm font-medium text-cool-700">
                  Séances
                </p>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
