"use client";

import { useActionState } from "react";
import { inviteMember as rawInviteMember } from "@/lib/actions/membership";

const inviteMember = async (_prevState: unknown, formData: FormData) => {
  return rawInviteMember(formData);
};

export function InviteMemberForm() {
  const [state, action, pending] = useActionState(inviteMember, undefined);

  const errorObj = state?.error;
  const errorMsg = typeof errorObj === "string" ? errorObj : null;
  const fieldErrors = errorObj && typeof errorObj === "object" && !Array.isArray(errorObj)
    ? (errorObj as Record<string, string[] | string>)
    : {};

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
            Email du membre
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="email@exemple.fr"
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          />
          {fieldErrors?.email && (
            <p className="mt-1 text-xs text-destructive">
              {Array.isArray(fieldErrors.email) ? fieldErrors.email[0] : fieldErrors.email}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="role" className="block text-sm font-medium text-foreground">
            Niveau d&apos;accès
          </label>
          <select
            id="role"
            name="role"
            required
            className="mt-1 block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          >
            <option value="dentist">Dentiste</option>
            <option value="assistant">Assistant</option>
            <option value="receptionist">Réceptionniste</option>
            <option value="viewer">Lecture seule</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            {pending ? "Invitation..." : "Inviter"}
          </button>
        </div>
      </div>

      {errorMsg && (
        <p className="text-sm text-destructive">{errorMsg}</p>
      )}
    </form>
  );
}
