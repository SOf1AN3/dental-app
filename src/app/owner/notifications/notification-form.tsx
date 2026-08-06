"use client";

import { useActionState } from "react";
import { createNotification } from "@/lib/actions/notifications";

type ClinicOption = {
  id: string;
  name: string;
};

export function NotificationForm({ clinics }: { clinics: ClinicOption[] }) {
  const [state, action, pending] = useActionState(createNotification, undefined);

  const fieldErrors = state && "error" in state && state.error && !("general" in state.error)
    ? (state.error as Record<string, string[] | undefined>)
    : {};

  const generalError = state && "error" in state && state.error && "general" in state.error
    ? state.error.general?.[0]
    : null;

  const success = state && "success" in state;

  return (
    <form action={action} className="grid grid-cols-2 gap-4">
      <div>
        <label htmlFor="target" className="block text-sm font-medium text-cool-700">Clinique cible</label>
        <select id="target" name="target" defaultValue="all"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none">
          <option value="all">Toutes les cliniques</option>
          {clinics.map((clinic) => (
            <option key={clinic.id} value={clinic.id}>{clinic.name}</option>
          ))}
        </select>
        {fieldErrors.target && <p className="mt-1 text-xs text-red-500">{fieldErrors.target[0]}</p>}
      </div>
      <div>
        <label htmlFor="category" className="block text-sm font-medium text-cool-700">Catégorie</label>
        <select id="category" name="category" defaultValue="broadcast"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none">
          <option value="broadcast">Diffusion (annonce)</option>
          <option value="maintenance">Maintenance</option>
          <option value="system">Système</option>
        </select>
        {fieldErrors.category && <p className="mt-1 text-xs text-red-500">{fieldErrors.category[0]}</p>}
      </div>
      <div className="col-span-2">
        <label htmlFor="title" className="block text-sm font-medium text-cool-700">Titre</label>
        <input id="title" name="title" type="text" required
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
        {fieldErrors.title && <p className="mt-1 text-xs text-red-500">{fieldErrors.title[0]}</p>}
      </div>
      <div className="col-span-2">
        <label htmlFor="message" className="block text-sm font-medium text-cool-700">Message</label>
        <textarea id="message" name="message" rows={3} required
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
        {fieldErrors.message && <p className="mt-1 text-xs text-red-500">{fieldErrors.message[0]}</p>}
      </div>
      <div className="col-span-2">
        <label htmlFor="link" className="block text-sm font-medium text-cool-700">Lien (optionnel)</label>
        <input id="link" name="link" type="text" placeholder="/settings/subscription"
          className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none" />
        {fieldErrors.link && <p className="mt-1 text-xs text-red-500">{fieldErrors.link[0]}</p>}
      </div>
      <div className="col-span-2 flex items-center gap-3 pt-2">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors">
          {pending ? "Envoi..." : "Envoyer la notification"}
        </button>
        {success && <p className="text-xs text-green-600">Notification envoyée</p>}
        {generalError && <p className="text-xs text-red-500">{generalError}</p>}
      </div>
    </form>
  );
}
