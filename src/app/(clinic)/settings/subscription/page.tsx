import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { clinicSubscriptions, subscriptionPlans, clinics } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { formatDate } from "@/lib/utils";
import { SubscribeForm, CancelSubscriptionForm } from "./subscribe-form";

const statusLabels: Record<string, { label: string; color: string }> = {
  trial: { label: "Essai", color: "bg-amber/10 text-amber" },
  active: { label: "Actif", color: "bg-mint/10 text-mint" },
  cancelled: { label: "Annulé", color: "bg-red/10 text-danger" },
  expired: { label: "Expiré", color: "bg-cool-100 text-cool-600" },
};

export default async function SubscriptionSettingsPage() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const [clinic, currentSub] = await Promise.all([
    db.query.clinics.findFirst({ where: eq(clinics.id, clinicId) }),
    db.query.clinicSubscriptions.findFirst({
      where: eq(clinicSubscriptions.clinicId, clinicId),
      orderBy: [desc(clinicSubscriptions.createdAt)],
      with: { plan: true },
    }),
  ]);

  const allPlans = await db.query.subscriptionPlans.findMany({
    where: eq(subscriptionPlans.isActive, true),
  });

  const hasActiveSubscription =
    currentSub?.status === "active" || clinic?.status === "active";

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-cool-200 bg-white p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Abonnement actuel
        </h2>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-cool-500">Statut:</span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            statusLabels[clinic?.status || "trial"]?.color || "bg-cool-100 text-cool-600"
          }`}>
            {statusLabels[clinic?.status || "trial"]?.label || clinic?.status || "Essai"}
          </span>
        </div>

        {currentSub ? (
          <div className="mt-4 space-y-2 text-sm">
            <p><span className="text-cool-500">Formule:</span> <span className="font-medium text-cool-900">{currentSub.plan?.name || "—"}</span></p>
            <p><span className="text-cool-500">Début:</span> <span className="text-cool-900">{formatDate(currentSub.startDate)}</span></p>
            {currentSub.endDate && (
              <p><span className="text-cool-500">Fin:</span> <span className="text-cool-900">{formatDate(currentSub.endDate)}</span></p>
            )}
            <p><span className="text-cool-500">Prix:</span> <span className="text-cool-900">
              {currentSub.plan?.priceMonthly
                ? `${currentSub.plan.priceMonthly.toFixed(2)} DA / mois`
                : "—"}
            </span></p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-cool-500">
              Vous êtes actuellement en période d&apos;essai. Choisissez une formule ci-dessous pour souscrire.
            </p>
            {clinic?.createdAt && (
              <p className="mt-1 text-xs text-cool-400">
                Clinique créée le {formatDate(clinic.createdAt)}
              </p>
            )}
          </div>
        )}

        {/* Cancel subscription section */}
        {hasActiveSubscription && (
          <div className="mt-6 border-t border-cool-200 pt-4">
            <h3 className="text-sm font-semibold text-cool-900">
              Résilier l&apos;abonnement
            </h3>
            <CancelSubscriptionForm />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-cool-200 bg-white p-6">
        <h2 className="mb-1 text-lg font-semibold text-cool-900">
          Formules disponibles
        </h2>
        <p className="mb-6 text-sm text-cool-500">
          Choisissez la formule qui correspond à vos besoins.
        </p>

        {allPlans.length === 0 ? (
          <p className="text-sm text-cool-400 text-center py-8">
            Aucune formule disponible pour le moment.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {allPlans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-lg border border-cool-200 p-5 hover:border-cerulean transition-colors"
              >
                <h3 className="text-lg font-semibold text-cool-900">{plan.name}</h3>
                <p className="mt-1 text-2xl font-bold text-primary">
                  {plan.priceMonthly.toFixed(2)} <span className="text-sm font-normal text-cool-500">DA/mois</span>
                </p>
                {plan.description && (
                  <p className="mt-2 text-sm text-cool-500">{plan.description}</p>
                )}
                <ul className="mt-4 space-y-1.5">
                  {plan.maxStaff && (
                    <li className="text-sm text-cool-600">
                      Jusqu&apos;à {plan.maxStaff} membres
                    </li>
                  )}
                  {plan.maxPatients && (
                    <li className="text-sm text-cool-600">
                      Jusqu&apos;à {plan.maxPatients} patients
                    </li>
                  )}
                </ul>
                <SubscribeForm
                  planId={plan.id}
                  planName={plan.name}
                  price={plan.priceMonthly}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
