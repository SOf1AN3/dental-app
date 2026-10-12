import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { clinicSubscriptions, subscriptionPlans, clinics } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { CreditCard } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { SubscribeForm, CancelSubscriptionForm } from "./subscribe-form";

const statusLabels: Record<string, { label: string; color: string }> = {
  trial: { label: "Essai", color: "bg-amber/10 text-amber-fg" },
  active: { label: "Actif", color: "bg-mint/10 text-mint" },
  cancelled: { label: "Annulé", color: "bg-danger/10 text-danger" },
  expired: { label: "Expiré", color: "bg-cool-100 text-cool-700 dark:text-muted-fg" },
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
      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Abonnement actuel
        </h2>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-muted-fg">Statut:</span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            statusLabels[clinic?.status || "trial"]?.color || "bg-cool-100 text-muted-fg"
          }`}>
            {statusLabels[clinic?.status || "trial"]?.label || clinic?.status || "Essai"}
          </span>
        </div>

        {currentSub ? (
          <div className="mt-4 space-y-2 text-sm">
            <p><span className="text-muted-fg">Formule:</span> <span className="font-medium text-foreground">{currentSub.plan?.name || "—"}</span></p>
            <p><span className="text-muted-fg">Début:</span> <span className="text-foreground">{formatDate(currentSub.startDate)}</span></p>
            {currentSub.endDate && (
              <p><span className="text-muted-fg">Fin:</span> <span className="text-foreground">{formatDate(currentSub.endDate)}</span></p>
            )}
            <p><span className="text-muted-fg">Prix:</span> <span className="text-foreground">
              {currentSub.plan?.priceMonthly
                ? `${currentSub.plan.priceMonthly.toFixed(2)} DA / mois`
                : "—"}
            </span></p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-muted-fg">
              Vous êtes actuellement en période d&apos;essai. Choisissez une formule ci-dessous pour souscrire.
            </p>
            {clinic?.createdAt && (
              <p className="mt-1 text-xs text-muted-fg">
                Clinique créée le {formatDate(clinic.createdAt)}
              </p>
            )}
          </div>
        )}

        {/* Cancel subscription section */}
        {hasActiveSubscription && (
          <div className="mt-6 border-t border-border-card pt-4">
            <h3 className="text-sm font-semibold text-foreground">
              Résilier l&apos;abonnement
            </h3>
            <CancelSubscriptionForm />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Formules disponibles
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Choisissez la formule qui correspond à vos besoins.
        </p>

        {/* Le titre « Paramètres » est rendu par `settings/layout.tsx`
            (PageHeader) : pas de PageHeader ici pour éviter le doublon. */}
        {allPlans.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="Aucune formule disponible pour le moment."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {allPlans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-lg border border-border-card p-5 hover:border-cerulean transition-colors"
              >
                <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-2xl font-bold text-primary">
                  {plan.priceMonthly.toFixed(2)} <span className="text-sm font-normal text-muted-fg">DA/mois</span>
                </p>
                {plan.description && (
                  <p className="mt-2 text-sm text-muted-fg">{plan.description}</p>
                )}
                <ul className="mt-4 space-y-1.5">
                  {plan.maxStaff && (
                    <li className="text-sm text-muted-fg">
                      Jusqu&apos;à {plan.maxStaff} membres
                    </li>
                  )}
                  {plan.maxPatients && (
                    <li className="text-sm text-muted-fg">
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
