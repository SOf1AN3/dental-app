import Link from "next/link";
import { LayoutDashboard, Users, Calendar, Sofa, DollarSign, Pill, Package, Bone, TrendingUp, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/clinic/theme-toggle";
import { UserMenu } from "@/components/clinic/user-menu";
import { auth } from "@/lib/auth";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import { redirect, unstable_rethrow } from "next/navigation";
import { getCurrentRole } from "@/lib/auth-utils";
import { can, NAV_ABILITY, type Role } from "@/lib/permissions";
import { SearchInput } from "@/components/clinic/search-input";
import { NotificationBell } from "@/components/clinic/notification-bell";

const sidebarLinks: { label: string; href: string; icon: React.ElementType }[] = [
  { label: "Tableau de bord", href: "/dashboard", icon: LayoutDashboard },
  { label: "Patients", href: "/patients", icon: Users },
  { label: "Rendez-vous", href: "/appointments", icon: Calendar },
  { label: "Salle d'attente", href: "/waiting-room", icon: Sofa },
  { label: "Facturation", href: "/billing", icon: DollarSign },
  { label: "Ordonnances", href: "/prescriptions", icon: Pill },
  { label: "Stock", href: "/stock", icon: Package },
  { label: "Prothèses", href: "/prostheses", icon: Bone },
  { label: "Rapports", href: "/reports", icon: TrendingUp },
  { label: "Paramètres", href: "/settings/general", icon: Settings },
];

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
  const visibleLinks =
    role === null
      ? sidebarLinks
      : sidebarLinks.filter((link) => {
          const ability = NAV_ABILITY[link.href];
          return ability ? can(role, ability) : true;
        });

  return (
    <div className="flex h-full min-h-screen">
      <aside className="fixed left-0 top-0 z-30 flex h-full w-64 flex-col bg-sidebar text-white">
        <div className="flex h-16 items-center gap-2 px-6 border-b border-white/10">
          <span className="text-xl font-bold">DentalCare</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          <ul className="space-y-1 px-3">
            {visibleLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <link.icon className="h-5 w-5" />
                  <span>{link.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-cerulean flex items-center justify-center text-sm font-medium">
              {initials}
            </div>
            <div className="text-sm">
              <p className="font-medium">{userName}</p>
              <Link
                href="/select-clinic"
                className="text-white/60 text-xs hover:text-white transition-colors"
              >
                Changer de clinique
              </Link>
            </div>
          </div>
        </div>
      </aside>

      <div className="ml-64 flex flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-cool-200 bg-white px-8 dark:bg-cool-100">
          <div className="flex-1">
            <SearchInput />
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <NotificationBell clinicId={clinicId} />
            <UserMenu name={userName} email={session?.user?.email} />
          </div>
        </header>

        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
