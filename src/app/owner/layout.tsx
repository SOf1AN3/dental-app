import { LayoutDashboard, Building2, ClipboardList, DollarSign, Ticket, HeartPulse, Bell, Download } from "lucide-react";
import { ThemeToggle } from "@/components/clinic/theme-toggle";
import { UserMenu } from "@/components/clinic/user-menu";
import { auth } from "@/lib/auth";
import { requirePlatformOwner } from "@/lib/auth-utils";
import { SidebarShell, type SidebarLink } from "@/components/ui/sidebar";

const ownerLinks: SidebarLink[] = [
  { label: "Plateforme", href: "/owner", icon: LayoutDashboard, group: "pilotage" },
  { label: "Cliniques", href: "/owner/clinics", icon: Building2, group: "clinique" },
  { label: "Abonnements", href: "/owner/plans", icon: ClipboardList, group: "clinique" },
  { label: "Facturation", href: "/owner/billing", icon: DollarSign, group: "clinique" },
  { label: "Support", href: "/owner/support", icon: Ticket, group: "suivi" },
  { label: "Santé", href: "/owner/health", icon: HeartPulse, group: "suivi" },
  { label: "Notifications", href: "/owner/notifications", icon: Bell, group: "suivi" },
  { label: "Exportation", href: "/owner/export", icon: Download, group: "suivi" },
];

/**
 * Dupliquée depuis `src/app/(clinic)/layout.tsx` : la factorisation en
 * utilitaire partagé est hors périmètre de cette tâche (signalé au Lead).
 */
function getUserInitials(name: string): string {
  return name
    .split(" ")
    .filter((w) => !w.includes("."))
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";
}

export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Garde d'autorisation : doit rester le premier appel du layout.
  await requirePlatformOwner();

  const session = await auth();
  const userName = session?.user?.name ?? "Admin";
  const initials = getUserInitials(userName);

  return (
    <div className="flex h-full min-h-dvh">
      {/*
        Composant client partagé avec l'espace clinic : barre fixe responsive
        (≥1280px dépliée, 768–1279px icônes seules, <768px drawer + burger),
        groupes, état actif et footer utilisateur. Le layout reste Server
        Component : il ne fournit que des données sérialisables.

        Le badge « Admin » est passé comme contenu (ReactNode) : la classe
        (`rounded bg-cerulean px-2 py-0.5 text-xs font-medium text-white`) est
        portée par `SidebarBody`, le DOM rendu reste donc
        `<span class="…">Admin</span>` à côté du titre.
      */}
      <SidebarShell
        links={ownerLinks}
        initials={initials}
        userName={userName}
        badge="Admin"
      />

      {/*
        Marges alignées sur les breakpoints de la sidebar :
        `<768px` pleine largeur (menu en drawer), `md` barre compacte (16),
        `xl` barre dépliée (64). `pl-14` en mobile libère la place du bouton
        burger fixé en haut à gauche.
      */}
      <div className="ml-0 flex w-full min-w-0 flex-1 flex-col md:ml-16 xl:ml-64">
        {/*
          Header sans `SearchInput` (la recherche patient n'a pas de sens pour
          l'admin plateforme) ni `NotificationBell` (ce composant exige un
          `clinicId` courant, que l'owner ne possède pas).
        */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-border-card bg-card pl-14 pr-8 md:pl-8">
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            <ThemeToggle />
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
