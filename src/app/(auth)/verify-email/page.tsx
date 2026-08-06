"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { verifyEmail, resendVerificationEmail } from "@/lib/actions/auth";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [verifyState, setVerifyState] = useState<{ success?: boolean; error?: string } | null>(null);
  const [resendState, setResendState] = useState<{ success?: boolean; error?: string } | null>(null);
  const [resendLoading, setResendLoading] = useState(false);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    verifyEmail(token).then(
      (result) => {
        if (!cancelled) setVerifyState(result);
      },
      () => {
        if (!cancelled) setVerifyState({ error: "Une erreur est survenue" });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [token]);

  const verifyLoading = Boolean(token) && !verifyState;

  async function handleResend() {
    setResendLoading(true);
    setResendState(null);
    const result = await resendVerificationEmail();
    setResendState(result);
    setResendLoading(false);
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-cool-900">Vérification de l&apos;email</h2>
        <p className="mt-1 text-sm text-cool-500">
          Vérifiez votre boîte de réception pour confirmer votre adresse email
        </p>
      </div>

      {verifyLoading && (
        <div className="rounded-lg bg-cool-50 border border-cool-200 p-3 text-sm text-cool-700">
          Vérification de votre email...
        </div>
      )}

      {verifyState?.success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
          Votre email a été vérifié avec succès
        </div>
      )}

      {verifyState?.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {verifyState.error}
        </div>
      )}

      {resendState?.success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
          Un email de vérification a été envoyé
        </div>
      )}

      {resendState?.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {resendState.error}
        </div>
      )}

      <button
        type="button"
        onClick={handleResend}
        disabled={resendLoading}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
      >
        {resendLoading ? "Envoi..." : "Renvoyer l'email de vérification"}
      </button>

      <p className="text-center text-sm text-cool-500">
        <a href="/login" className="font-medium text-cerulean hover:text-cerulean/80">
          Se connecter
        </a>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-cool-500">Chargement...</div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
