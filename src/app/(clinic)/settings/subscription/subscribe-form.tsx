"use client";

import { useActionState, useState } from "react";
import { subscribeToPlan as rawSubscribeToPlan, cancelSubscription as rawCancelSubscription } from "@/lib/actions/subscription";
import { AlertTriangle, Trash2, ArrowLeft } from "lucide-react";

const subscribeToPlan = async (_prevState: unknown, formData: FormData) => {
  return rawSubscribeToPlan(formData);
};

const cancelSubscription = async (_prevState: unknown, _formData: FormData) => {
  return rawCancelSubscription();
};

export function SubscribeForm({
  planId,
  planName,
  price,
}: {
  planId: string;
  planName: string;
  price: number;
}) {
  const [state, action, pending] = useActionState(subscribeToPlan, undefined);

  const errorMsg = typeof state?.error === "string" ? state.error : null;

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="planId" value={planId} />

      <div className="mb-3 rounded-lg border border-cool-200 bg-cool-50 p-3 text-sm">
        <p className="font-medium text-cool-900">{planName}</p>
        <p className="text-primary font-semibold">
          {price.toFixed(2)} <span className="text-xs font-normal text-cool-500">DA / mois</span>
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
      >
        {pending ? "Souscription en cours…" : "Confirmer l'abonnement"}
      </button>

      {errorMsg && <p className="mt-2 text-sm text-red-500">{errorMsg}</p>}
    </form>
  );
}

export function CancelSubscriptionForm() {
  const [step, setStep] = useState<"warning" | "confirm">("warning");
  const [confirmText, setConfirmText] = useState("");
  const [state, action, pending] = useActionState(cancelSubscription, undefined);

  const resetForm = () => {
    setStep("warning");
    setConfirmText("");
  };

  const errorMsg = typeof state?.error === "string" ? state.error : null;

  if (step === "warning") {
    return (
      <div className="mt-6 rounded-xl border border-red-200 bg-red-50/50 p-6 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-500/20">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800 dark:text-red-400">
                Zone de danger
              </h3>
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              Vous êtes sur le point de résilier votre abonnement actuel. Cette action est irréversible et entraînera la perte d&apos;accès aux fonctionnalités de votre formule.
            </p>
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className="inline-flex items-center gap-2 rounded-lg border-2 border-red-200 bg-white px-5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors dark:bg-cool-100 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" />
                Résilier l&apos;abonnement
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4">
      <div className="rounded-xl border border-red-200 bg-red-50/50 p-6 dark:bg-red-500/10 dark:border-red-500/20 dark:text-red-400">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-500/20">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="flex-1 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-red-800 dark:text-red-400">
                Confirmer la résiliation
              </h3>
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                Êtes-vous sûr de vouloir résilier ? Cette action est irréversible.
              </p>
            </div>

            <div>
              <label htmlFor="confirmCancel" className="block text-sm font-medium text-red-700 mb-1.5 dark:text-red-400">
                Tapez <span className="font-mono font-bold tracking-wider text-red-800 dark:text-red-400">CONFIRMER</span> pour confirmer
              </label>
              <input
                id="confirmCancel"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CONFIRMER"
                className="block w-full rounded-lg border border-red-300 bg-white px-3 py-2.5 text-sm placeholder:text-cool-300 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 dark:bg-cool-100 dark:border-red-500/40 dark:placeholder:text-cool-500"
              />
            </div>

            <div className="flex justify-center gap-3">
              <button
                type="submit"
                disabled={pending || confirmText !== "CONFIRMER"}
                className="inline-flex items-center gap-2 rounded-lg border-2 border-red-200 bg-white px-5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors dark:bg-cool-100 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" />
                {pending ? "Annulation en cours…" : "Confirmer la résiliation"}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center gap-2 rounded-lg border border-cool-200 px-5 py-2.5 text-sm font-medium text-cool-600 hover:bg-cool-50 transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Retour
              </button>
            </div>
          </div>
        </div>
      </div>

      {errorMsg && <p className="mt-2 text-sm text-red-500">{errorMsg}</p>}
    </form>
  );
}
