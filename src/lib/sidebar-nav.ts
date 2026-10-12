import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Sofa,
  DollarSign,
  Pill,
  Package,
  Bone,
  TrendingUp,
  Settings,
  Building2,
  ClipboardList,
  Ticket,
  HeartPulse,
  Bell,
  Download,
} from "lucide-react";

/**
 * Définitions de navigation de la sidebar — **module sans `"use client"`**,
 * importable aussi bien par les Server Components (layouts) que par le
 * composant client `SidebarShell`.
 *
 * Frontière serveur/client : un composant (icône lucide) ne peut PAS traverser
 * la frontière RSC → Client Components. Les layouts serveur ne transmettent
 * donc que `visibleHrefs: string[]` ; le client, lui, possède la définition
 * complète des liens (label, icône, groupe) et filtre localement.
 */
export type SidebarGroup = "pilotage" | "clinique" | "suivi" | "reglages";

export interface SidebarLink {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Groupe d'appartenance — sert au regroupement visuel */
  group: SidebarGroup;
}

/** Jeu de liens de l'espace clinique (filtré par rôle côté serveur). */
export const CLINIC_SIDEBAR_LINKS: SidebarLink[] = [
  { label: "Tableau de bord", href: "/dashboard", icon: LayoutDashboard, group: "pilotage" },
  { label: "Patients", href: "/patients", icon: Users, group: "clinique" },
  { label: "Rendez-vous", href: "/appointments", icon: Calendar, group: "clinique" },
  { label: "Salle d'attente", href: "/waiting-room", icon: Sofa, group: "clinique" },
  { label: "Facturation", href: "/billing", icon: DollarSign, group: "suivi" },
  { label: "Ordonnances", href: "/prescriptions", icon: Pill, group: "suivi" },
  { label: "Stock", href: "/stock", icon: Package, group: "suivi" },
  { label: "Prothèses", href: "/prostheses", icon: Bone, group: "suivi" },
  { label: "Rapports", href: "/reports", icon: TrendingUp, group: "suivi" },
  { label: "Paramètres", href: "/settings/general", icon: Settings, group: "reglages" },
];

/** Jeu de liens de l'espace propriétaire de plateforme (aucun filtrage par rôle). */
export const OWNER_SIDEBAR_LINKS: SidebarLink[] = [
  { label: "Plateforme", href: "/owner", icon: LayoutDashboard, group: "pilotage" },
  { label: "Cliniques", href: "/owner/clinics", icon: Building2, group: "clinique" },
  { label: "Abonnements", href: "/owner/plans", icon: ClipboardList, group: "clinique" },
  { label: "Facturation", href: "/owner/billing", icon: DollarSign, group: "clinique" },
  { label: "Support", href: "/owner/support", icon: Ticket, group: "suivi" },
  { label: "Santé", href: "/owner/health", icon: HeartPulse, group: "suivi" },
  { label: "Notifications", href: "/owner/notifications", icon: Bell, group: "suivi" },
  { label: "Exportation", href: "/owner/export", icon: Download, group: "suivi" },
];
