"use client";

import { useActionState, useState } from "react";
import { togglePlanActive, updateSubscriptionPlan, deleteSubscriptionPlan } from "@/lib/actions/owner";
import { Pencil, Trash2, X, AlertTriangle } from "lucide-react";

type Plan = {
  id: string;
  name: string;
  code: string;
  priceMonthly: number;
  priceYearly: number | null;
  maxStaff: number | null;
  maxPatients: number | null;
  isActive: boolean;
};

export function PlanActions({ plan }: { plan: Plan }) {
  const [showToggleConfirm, setShowToggleConfirm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setShowEdit(true)}
        className="rounded-lg p-1.5 text-cool-500 hover:bg-cool-100 hover:text-cerulean transition-colors"
        title="Modifier"
      >
        <Pencil className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => setShowDeleteConfirm(true)}
        className="rounded-lg p-1.5 text-cool-500 hover:bg-cool-100 hover:text-danger transition-colors"
        title="Supprimer"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      {!showToggleConfirm ? (
        <button
          type="button"
          onClick={() => setShowToggleConfirm(true)}
          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
            plan.isActive
              ? "text-amber-600 hover:bg-amber-50"
              : "text-mint hover:bg-mint/10"
          }`}
        >
          {plan.isActive ? "Désactiver" : "Activer"}
        </button>
      ) : (
        <ToggleConfirm planId={plan.id} isActive={plan.isActive} onCancel={() => setShowToggleConfirm(false)} />
      )}

      {showEdit && (
        <EditPlanDialog plan={plan} onClose={() => setShowEdit(false)} />
      )}

      {showDeleteConfirm && (
        <DeletePlanDialog plan={plan} onClose={() => setShowDeleteConfirm(false)} />
      )}
    </div>
  );
}

function ToggleConfirm({ planId, isActive, onCancel }: { planId: string; isActive: boolean; onCancel: () => void }) {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    setPending(true);
    await togglePlanActive(planId, !isActive);
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-medium text-amber-600">Confirmer ?</span>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={pending}
        className={`rounded px-1.5 py-1 text-xs font-medium text-white transition-colors ${
          isActive ? "bg-amber hover:bg-amber/80" : "bg-mint hover:opacity-90"
        } disabled:opacity-50`}
      >
        {pending ? "..." : "Oui"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded px-1.5 py-1 text-xs font-medium text-cool-500 hover:bg-cool-100 transition-colors"
      >
        Non
      </button>
    </div>
  );
}

function EditPlanDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const updatePlanBound = updateSubscriptionPlan.bind(null, plan.id);
  const [state, action, pending] = useActionState(updatePlanBound, undefined);

  const fieldErrors = state && 'error' in state && state.error && !('general' in state.error)
    ? state.error as Record<string, string[] | undefined>
    : {} as Record<string, string[] | undefined>;

  const success = state && 'success' in state;
  if (success) {
    onClose();
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-cool-900">Modifier le plan</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-cool-500 hover:bg-cool-100 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form action={action} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label htmlFor="edit-name" className="block text-sm font-medium text-cool-700">Nom</label>
            <input id="edit-name" name="name" type="text" required defaultValue={plan.name}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
            {fieldErrors?.name && <p className="mt-1 text-xs text-red-500">{fieldErrors.name[0]}</p>}
          </div>
          <div>
            <label htmlFor="edit-code" className="block text-sm font-medium text-cool-700">Code</label>
            <input id="edit-code" name="code" type="text" required defaultValue={plan.code}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
            {fieldErrors?.code && <p className="mt-1 text-xs text-red-500">{fieldErrors.code[0]}</p>}
          </div>
          <div>
            <label htmlFor="edit-priceMonthly" className="block text-sm font-medium text-cool-700">Prix mensuel (DA)</label>
            <input id="edit-priceMonthly" name="priceMonthly" type="number" required step="0.01" defaultValue={plan.priceMonthly}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
            {fieldErrors?.priceMonthly && <p className="mt-1 text-xs text-red-500">{fieldErrors.priceMonthly[0]}</p>}
          </div>
          <div>
            <label htmlFor="edit-priceYearly" className="block text-sm font-medium text-cool-700">Prix annuel (DA)</label>
            <input id="edit-priceYearly" name="priceYearly" type="number" step="0.01" defaultValue={plan.priceYearly ?? ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
          </div>
          <div>
            <label htmlFor="edit-maxStaff" className="block text-sm font-medium text-cool-700">Max personnel</label>
            <input id="edit-maxStaff" name="maxStaff" type="number" defaultValue={plan.maxStaff ?? ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
          </div>
          <div>
            <label htmlFor="edit-maxPatients" className="block text-sm font-medium text-cool-700">Max patients</label>
            <input id="edit-maxPatients" name="maxPatients" type="number" defaultValue={plan.maxPatients ?? ""}
              className="mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean" />
          </div>
          <div className="col-span-2 flex items-center gap-3 pt-2">
            <button type="submit" disabled={pending}
              className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors">
              {pending ? "Enregistrement..." : "Enregistrer"}
            </button>
            <button type="button" onClick={onClose}
              className="rounded-lg border border-cool-200 px-6 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors">
              Annuler
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeletePlanDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setPending(true);
    setError(null);
    const result = await deleteSubscriptionPlan(plan.id);
    if ('error' in result && result.error) {
      setError(result.error);
      setPending(false);
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-5 w-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-cool-900">Supprimer le plan</h3>
            <p className="text-sm text-cool-500">Cette action est irréversible</p>
          </div>
        </div>
        <p className="text-sm text-cool-600 mb-6">
          Êtes-vous sûr de vouloir supprimer le plan <strong>{plan.name}</strong> ({plan.code})&nbsp;?
        </p>
        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}
        <div className="flex items-center gap-3 justify-end">
          <button type="button" onClick={onClose}
            className="rounded-lg border border-cool-200 px-4 py-2 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors">
            Annuler
          </button>
          <button type="button" onClick={handleDelete} disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-red px-4 py-2 text-sm font-medium text-white hover:bg-red/90 disabled:opacity-50 transition-colors">
            <Trash2 className="h-4 w-4" />
            {pending ? "Suppression..." : "Supprimer"}
          </button>
        </div>
      </div>
    </div>
  );
}
