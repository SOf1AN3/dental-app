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
        <h2 className="text-xl font-semibold text-foreground">Vérification de l&apos;email</h2>
        <p className="mt-1 text-sm text-muted-fg">
          Vérifiez votre boîte de réception pour confirmer votre adresse email
        </p>
      </div>

      {verifyLoading && (
        <div className="rounded-lg border border-border-card bg-card p-3 text-sm text-muted-fg">
          Vérification de votre email...
        </div>
      )}

      {verifyState?.success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400">
          Votre email a été vérifié avec succès
        </div>
      )}

      {verifyState?.error && (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {verifyState.error}
        </div>
      )}

      {resendState?.success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 dark:bg-green-500/10 dark:border-green-500/20 dark:text-green-400">
          Un email de vérification a été envoyé
        </div>
      )}

      {resendState?.error && (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {resendState.error}
        </div>
      )}

      <button
        type="button"
        onClick={handleResend}
        disabled={resendLoading}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        {resendLoading ? "Envoi..." : "Renvoyer l'email de vérification"}
      </button>

      <p className="text-center text-sm text-muted-fg">
        <a href="/login" className="font-medium text-cerulean hover:text-cerulean/80">
          Se connecter
        </a>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-fg">Chargement...</div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
