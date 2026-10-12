"use client";

import { useActionState } from "react";
import { updatePatient } from "@/lib/actions/patient";
import { WILAYAS } from "@/lib/constants";

interface PatientEditFormProps {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: Date | null;
    gender: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    wilayaCode: string | null;
    emergencyContact: string | null;
    emergencyPhone: string | null;
    insuranceProvider: string | null;
    insuranceNumber: string | null;
    notes: string | null;
  };
}

export function PatientEditForm({ patient }: PatientEditFormProps) {
  const [state, action, pending] = useActionState(
    updatePatient.bind(null, patient.id),
    undefined,
  );

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Informations personnelles
        </h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="firstName"
              className="block text-sm font-medium text-foreground"
            >
              Prénom *
            </label>
            <input
              id="firstName"
              name="firstName"
              type="text"
              required
              defaultValue={patient.firstName}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
            {fieldErrors?.firstName && (
              <p className="mt-1 text-xs text-destructive">
                {fieldErrors.firstName[0]}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="lastName"
              className="block text-sm font-medium text-foreground"
            >
              Nom *
            </label>
            <input
              id="lastName"
              name="lastName"
              type="text"
              required
              defaultValue={patient.lastName}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
            {fieldErrors?.lastName && (
              <p className="mt-1 text-xs text-destructive">
                {fieldErrors.lastName[0]}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="dateOfBirth"
              className="block text-sm font-medium text-foreground"
            >
              Date de naissance
            </label>
            <input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              defaultValue={
                patient.dateOfBirth
                  ? new Date(patient.dateOfBirth).toISOString().split("T")[0]
                  : ""
              }
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
            {fieldErrors?.dateOfBirth && (
              <p className="mt-1 text-xs text-destructive">
                {fieldErrors.dateOfBirth[0]}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="gender"
              className="block text-sm font-medium text-foreground"
            >
              Genre
            </label>
            <select
              id="gender"
              name="gender"
              defaultValue={patient.gender || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            >
              <option value="">Non spécifié</option>
              <option value="Homme">Homme</option>
              <option value="Femme">Femme</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="phone"
              className="block text-sm font-medium text-foreground"
            >
              Téléphone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              defaultValue={patient.phone || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              placeholder="+213 5XX XX XX XX"
            />
          </div>
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-foreground"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={patient.email || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
            {fieldErrors?.email && (
              <p className="mt-1 text-xs text-destructive">
                {fieldErrors.email[0]}
              </p>
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor="address"
            className="block text-sm font-medium text-foreground"
          >
            Adresse
          </label>
          <input
            id="address"
            name="address"
            type="text"
            defaultValue={patient.address || ""}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="wilayaCode"
            className="block text-sm font-medium text-foreground"
          >
            Wilaya
          </label>
          <select
            id="wilayaCode"
            name="wilayaCode"
            defaultValue={patient.wilayaCode || ""}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          >
            <option value="">Sélectionner une wilaya</option>
            {WILAYAS.map((w) => (
              <option key={w.code} value={w.code}>
                {w.code} - {w.nameFr}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Contact d&apos;urgence
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="emergencyContact"
              className="block text-sm font-medium text-foreground"
            >
              Contact
            </label>
            <input
              id="emergencyContact"
              name="emergencyContact"
              type="text"
              defaultValue={patient.emergencyContact || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="emergencyPhone"
              className="block text-sm font-medium text-foreground"
            >
              Téléphone
            </label>
            <input
              id="emergencyPhone"
              name="emergencyPhone"
              type="tel"
              defaultValue={patient.emergencyPhone || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Assurance</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="insuranceProvider"
              className="block text-sm font-medium text-foreground"
            >
              Mutuelle
            </label>
            <input
              id="insuranceProvider"
              name="insuranceProvider"
              type="text"
              defaultValue={patient.insuranceProvider || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="insuranceNumber"
              className="block text-sm font-medium text-foreground"
            >
              N° d&apos;adhérent
            </label>
            <input
              id="insuranceNumber"
              name="insuranceNumber"
              type="text"
              defaultValue={patient.insuranceNumber || ""}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Notes</h2>
        <div>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={patient.notes || ""}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending ? "Enregistrement..." : "Enregistrer"}
        </button>
        <a
          href={`/patients/${patient.id}`}
          className="rounded-lg border border-border-input px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          Annuler
        </a>
      </div>
    </form>
  );
}
