"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createLab, updateLab } from "@/lib/actions/prosthesis";

interface LabFormProps {
  labId?: string;
  defaultValues?: {
    name: string;
    contactPerson: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
  };
}

export function LabForm({ labId, defaultValues }: LabFormProps) {
  const action = labId ? updateLab.bind(null, labId) : createLab;
  const [state, formAction, pending] = useActionState(action, undefined);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  return (
    <form action={formAction} className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-cool-900">
          Informations du laboratoire
        </h2>

        <div>
          <label htmlFor="name" className="block text-sm font-medium text-foreground">
            Nom *
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            defaultValue={defaultValues?.name}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {fieldErrors?.name && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>
          )}
        </div>

        <div>
          <label htmlFor="contactPerson" className="block text-sm font-medium text-foreground">
            Personne de contact
          </label>
          <input
            id="contactPerson"
            name="contactPerson"
            type="text"
            defaultValue={defaultValues?.contactPerson}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-foreground">
              Téléphone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              defaultValue={defaultValues?.phone}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={defaultValues?.email}
              className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="address" className="block text-sm font-medium text-foreground">
            Adresse
          </label>
          <input
            id="address"
            name="address"
            type="text"
            defaultValue={defaultValues?.address}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-foreground">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={defaultValues?.notes}
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {pending
            ? "Enregistrement..."
            : labId
              ? "Enregistrer"
              : "Créer le laboratoire"}
        </button>
        <Link
          href="/prostheses"
          className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}
