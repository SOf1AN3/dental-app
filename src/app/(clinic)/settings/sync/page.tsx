import { requireAuth } from "@/lib/auth-utils";
import { getSyncOverview } from "@/lib/actions/sync";
import { SyncControls } from "@/components/offline/sync-controls";
import { ConflictList } from "@/components/offline/conflict-list";
import { MergeReview } from "@/components/offline/merge-review";

/**
 * Tâche 7.2 — `/settings/sync` : interface de synchronisation.
 *
 * Server Component : session, puis lecture via la server action
 * `getSyncOverview` (conflits, revues de fusion, comptages de la file — sans
 * secret). La garde multi-tenant (cookie `active_clinic_id` revalidé contre
 * `clinicMemberships`) est exécutée **par l'action** et son résultat est renvoyé
 * dans `overview.clinicId` : la page ne ré-exécute donc pas
 * `requireCurrentClinic` (une seule requête membership par requête). Les
 * boutons IPC (`triggerSync`, `loginToSync`) vivent dans les Client Components
 * voisins.
 *
 * Mode web : les sections de revue restent servies (données locales vides en
 * pratique) et le panneau de contrôle affiche un état neutre — jamais d'erreur.
 */
export default async function SyncSettingsPage() {
  await requireAuth();
  const overview = await getSyncOverview();
  const clinicId = overview.clinicId;

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Synchronisation
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Suivez l&apos;état des données locales et leur envoi vers le serveur central.
        </p>
        <SyncControls
          clinicId={clinicId}
          pendingCount={overview.pendingCount}
          failedCount={overview.failedCount}
        />
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Conflits en attente de revue
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Lignes arbitrées par le serveur central lors du dernier push (D-4).
        </p>
        <ConflictList conflicts={overview.conflicts} />
      </section>

      <section className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          Doublons de patients en attente
        </h2>
        <p className="mb-6 text-sm text-muted-fg">
          Paires refusées par les garde-fous de fusion automatique (D-5) : comparez puis
          tranchez. La fusion n&apos;est jamais automatique ici.
        </p>
        <MergeReview merges={overview.merges} />
      </section>
    </div>
  );
}
