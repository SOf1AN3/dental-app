import { ThemeToggle } from "@/components/clinic/theme-toggle";
import { UserMenu } from "@/components/clinic/user-menu";
import { auth } from "@/lib/auth";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import { redirect, unstable_rethrow } from "next/navigation";
import { getCurrentRole } from "@/lib/auth-utils";
import { can, NAV_ABILITY, type Role } from "@/lib/permissions";
import { SearchInput } from "@/components/clinic/search-input";
import { NotificationBell } from "@/components/clinic/notification-bell";
import { SyncStatus } from "@/components/offline/sync-status";
import { SidebarShell } from "@/components/ui/sidebar";
import { CLINIC_SIDEBAR_LINKS } from "@/lib/sidebar-nav";

function getUserInitials(name: string): string {
  return name
    .split(" ")
    .filter((w) => !w.includes("."))
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";
}

export default async function ClinicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const userName = session?.user?.name ?? "Dr. User";
  const initials = getUserInitials(userName);

  // Défense en profondeur (PAR-1) : le middleware (src/proxy.ts) vérifie déjà
  // session + appartenance sur chaque requête, mais le cookie
  // `active_clinic_id` se forge côté client. Ce garde rend chaque page du
  // groupe sûre même si le middleware régresse (point d'échec unique sur des
  // données de santé). `requireCurrentClinic()` valide le cookie contre
  // `clinicMemberships` (joinedAt) et `clinics.deletedAt` en une opération.
  let clinicId: string;
  try {
    clinicId = await requireCurrentClinic();
  } catch (error) {
    // `requireCurrentClinic` peut lever `redirect()` (/select-clinic si le
    // cookie est absent, /login si la session l'est) via
    // getCurrentClinicId/requireAuth. Ces erreurs internes Next DOIVENT
    // traverser le layout : un redirect() avalé par un catch produirait une
    // page d'erreur au lieu de la redirection. `unstable_rethrow` relance
    // exactement ces erreurs de contrôle de flux et ignore le reste.
    unstable_rethrow(error);
    // Refus net : cookie techniquement présent mais l'utilisateur n'est pas
    // membre de cette clinique (ou clinique archivée). Comme le middleware,
    // on renvoie vers /select-clinic plutôt que vers l'error boundary :
    // c'est une impasse (un bouton « Réessayer » échouerait à l'identique),
    // alors que /select-clinic offre une issue (choisir une clinique
    // appartenant réellement à l'utilisateur).
    redirect("/select-clinic");
  }

  // Nav filtering is UX only; every page/action re-checks server-side (PAR-1).
  // Toléré volontairement : l'appartenance est déjà prouvée par
  // requireCurrentClinic ci-dessus, un échec ici (DB transitoire) ne doit pas
  // verrouiller l'accès — role=null affiche tous les liens, sans risque
  // sécurité puisque chaque page/action re-vérifie.
  let role: Role | null = null;
  try {
    role = await getCurrentRole(clinicId);
  } catch {
    role = null;
  }
  const visibleHrefs =
    role === null
      ? CLINIC_SIDEBAR_LINKS.map((l) => l.href)
      : CLINIC_SIDEBAR_LINKS.filter((link) => {
          const ability = NAV_ABILITY[link.href];
          return ability ? can(role, ability) : true;
        }).map((l) => l.href);

  return (
    <div className="flex h-full min-h-dvh">
      {/*
        Composant client complet (barre fixe responsive + drawer mobile) :
        il ne reçoit que des données sérialisables (identifiant de jeu de
        liens + hrefs visibles), le layout reste Server Component. Les
        libellés, icônes et groupes sont définis côté client
        (`@/lib/sidebar-nav`) : un composant ne peut traverser la frontière
        RSC → Client Components. Le garde multi-tenant ci-dessus s'exécute
        avant, sur le serveur, et ne dépend donc pas de cette extraction.
      */}
      <SidebarShell
        nav="clinic"
        visibleHrefs={visibleHrefs}
        initials={initials}
        userName={userName}
      />

      {/*
        Marges alignées sur les breakpoints de la sidebar :
        `<768px` pleine largeur (menu en drawer), `md` barre compacte (16),
        `xl` barre dépliée (64). `pl-14` en mobile libère la place du bouton
        burger fixé en haut à gauche, sinon il recouvre le champ de recherche.
      */}
      <div className="ml-0 flex w-full min-w-0 flex-1 flex-col md:ml-16 xl:ml-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-border-card bg-card pl-14 pr-8 md:pl-8">
          <div className="flex-1">
            <SearchInput />
          </div>
          <div className="flex items-center gap-4">
            {/* Tâche 7.2 — indicateur de synchro : ne rend rien en mode web
                (pas de `window.desktop`), le layout navigateur est inchangé. */}
            <SyncStatus />
            <ThemeToggle />
            <NotificationBell clinicId={clinicId} />
            <UserMenu name={userName} email={session?.user?.email} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
