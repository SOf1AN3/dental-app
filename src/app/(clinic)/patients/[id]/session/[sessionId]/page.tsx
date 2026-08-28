import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId, requireClinicAccess } from "@/lib/multi-tenant";
import { getSession } from "@/lib/actions/session";
import { getCurrentClinic, getCurrentUserProfile } from "@/lib/actions/settings";
import { getTreatmentCatalog } from "@/lib/actions/treatment-catalog";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDate, cn } from "@/lib/utils";
import { buildA5Template } from "@/lib/document-branding";
import type { A5Item } from "@/components/clinic/a5-prescription";
import { SessionStatusBadge } from "@/components/clinic/session-status-badge";
import { SessionTreatments } from "@/components/clinic/session-treatments";
import { SessionPrescription } from "@/components/clinic/session-prescription";
import { SessionInvoice, type InvoiceData } from "@/components/clinic/session-invoice";
import { DeleteSessionButton } from "@/components/clinic/delete-session-button";

const TABS = [
  { key: "traitements", label: "Traitements" },
  { key: "ordonnance", label: "Ordonnance" },
  { key: "facture", label: "Facture" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default async function SessionDetailPage(props: {
  params: Promise<{ id: string; sessionId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { membership } = await requireClinicAccess(clinicId);
  const { id, sessionId } = await props.params;
  const { tab } = await props.searchParams;

  const session = await getSession(sessionId);
  if (!session || !session.patient || session.patient.id !== id) notFound();

  const canDelete =
    session.status === "in_progress" &&
    (session.dentistId === user.id || membership.role === "owner");

  const [clinic, profile, catalog] = await Promise.all([
    getCurrentClinic(),
    getCurrentUserProfile(),
    getTreatmentCatalog(),
  ]);

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const clinicTemplate = buildA5Template(clinic, { logoUrl, headerUrl });

  const dentistName = profile?.name ?? null;
  const activeTab: TabKey =
    tab === "ordonnance" || tab === "facture" ? tab : "traitements";

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Link
            href={`/patients/${id}`}
            className="text-sm text-cerulean hover:text-cerulean/80 inline-block"
          >
            ← Retour au dossier
          </Link>
          <span className="text-sm text-cool-300">•</span>
          <Link
            href={`/patients/${id}/sessions`}
            className="text-sm text-cerulean hover:text-cerulean/80 inline-block"
          >
            Historique des séances
          </Link>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-cool-900">
              {session.patient.firstName} {session.patient.lastName}
            </h1>
            <SessionStatusBadge status={session.status} />
          </div>
          {canDelete && <DeleteSessionButton sessionId={sessionId} patientId={id} />}
        </div>
        <p className="mt-1 text-sm text-cool-500">
          {formatDate(session.startedAt ?? session.createdAt)}
        </p>
      </div>

      <div className="mb-6 border-b border-cool-200">
        <nav className="flex items-center gap-6">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/patients/${id}/session/${sessionId}?tab=${t.key}`}
              className={cn(
                "pb-3 text-sm transition-colors",
                activeTab === t.key
                  ? "border-b-2 border-cerulean font-medium text-cool-900"
                  : "text-cool-500 hover:text-cool-700",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      {activeTab === "traitements" && (
        <SessionTreatments
          sessionId={sessionId}
          initialItems={session.items}
          catalog={catalog}
          disabled={session.status !== "in_progress"}
        />
      )}

      {activeTab === "ordonnance" && (
        <SessionPrescription
          sessionId={sessionId}
          prescription={
            session.prescription
              ? {
                  id: session.prescription.id,
                  notes: session.prescription.notes,
                  items: session.prescription.items as unknown as A5Item[],
                  rxNumber: session.prescription.id.slice(0, 8),
                }
              : null
          }
          patient={{
            id: session.patient.id,
            firstName: session.patient.firstName,
            lastName: session.patient.lastName,
            dateOfBirth: session.patient.dateOfBirth ?? null,
          }}
          clinicTemplate={clinicTemplate}
          dentistName={dentistName}
          disabled={session.status === "paid"}
        />
      )}

      {activeTab === "facture" && (
        <SessionInvoice
          sessionId={sessionId}
          patientId={session.patient.id}
          status={session.status}
          invoice={session.invoice as unknown as InvoiceData | null}
          prescriptionId={session.prescription?.id ?? null}
        />
      )}
    </div>
  );
}
