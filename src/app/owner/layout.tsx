import Link from "next/link";
import { requirePlatformOwner } from "@/lib/auth-utils";
import { LayoutDashboard, Building2, ClipboardList, DollarSign, Ticket, HeartPulse, Bell } from "lucide-react";

export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePlatformOwner();

  return (
    <div className="flex h-full min-h-screen">
      <aside className="fixed left-0 top-0 z-30 flex h-full w-56 flex-col bg-cool-900 text-white">
        <div className="flex h-16 items-center gap-2 px-6 border-b border-white/10">
          <span className="text-lg font-bold">DentalCare</span>
          <span className="rounded bg-cerulean px-2 py-0.5 text-xs font-medium">Admin</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          <ul className="space-y-1 px-3">
            {([
              { label: "Plateforme", href: "/owner", icon: LayoutDashboard },
              { label: "Cliniques", href: "/owner/clinics", icon: Building2 },
              { label: "Abonnements", href: "/owner/plans", icon: ClipboardList },
              { label: "Facturation", href: "/owner/billing", icon: DollarSign },
              { label: "Support", href: "/owner/support", icon: Ticket },
              { label: "Santé", href: "/owner/health", icon: HeartPulse },
              { label: "Notifications", href: "/owner/notifications", icon: Bell },
            ] as { label: string; href: string; icon: React.ElementType }[]).map((link) => (
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
      </aside>
      <div className="ml-56 flex flex-1 flex-col">
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
