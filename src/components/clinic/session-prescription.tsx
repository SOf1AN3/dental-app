"use client";

import Link from "next/link";
import { PrescriptionEditor } from "@/components/clinic/prescription-editor";
import type { A5Template, A5Item } from "@/components/clinic/a5-prescription";

interface SessionPrescriptionProps {
  sessionId: string;
  prescription: {
    id: string;
    notes: string | null;
    items: A5Item[];
    rxNumber: string;
  } | null;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: Date | string | null;
  };
  clinicTemplate: A5Template;
  dentistName: string | null;
  disabled?: boolean;
}

export function SessionPrescription({
  sessionId,
  prescription,
  patient,
  clinicTemplate,
  dentistName,
  disabled = false,
}: SessionPrescriptionProps) {
  if (disabled) {
    return (
      <div className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
          Ordonnance
        </h2>
        {prescription ? (
          <div className="space-y-2">
            <p className="text-sm text-foreground">N° {prescription.rxNumber}</p>
            <p className="text-sm text-muted-fg">
              {prescription.items.length} article
              {prescription.items.length > 1 ? "s" : ""}
            </p>
            <Link
              href={`/prescriptions/${prescription.id}/print`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-cerulean hover:text-cerulean/80 inline-block"
            >
              Imprimer l&apos;ordonnance (A5)
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted-fg">Aucune ordonnance</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {prescription && (
        <div className="flex items-center justify-end">
          <Link
            href={`/prescriptions/${prescription.id}/print`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Imprimer l&apos;ordonnance (A5)
          </Link>
        </div>
      )}

      {prescription ? (
        <PrescriptionEditor
          id={prescription.id}
          sessionId={sessionId}
          initialData={{
            patient: {
              id: patient.id,
              firstName: patient.firstName,
              lastName: patient.lastName,
              dateOfBirth: patient.dateOfBirth ?? null,
            },
            notes: prescription.notes,
            items: prescription.items,
            rxNumber: prescription.rxNumber,
          }}
          fixedPatient
          clinicTemplate={clinicTemplate}
          dentistName={dentistName}
        />
      ) : (
        <PrescriptionEditor
          sessionId={sessionId}
          patientPreset={patient}
          fixedPatient
          clinicTemplate={clinicTemplate}
          dentistName={dentistName}
        />
      )}
    </div>
  );
}
