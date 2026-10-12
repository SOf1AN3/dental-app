import { cn } from "@/lib/utils";

/**
 * Badge de statut unifié.
 *
 * - Les valeurs brutes des enums PostgreSQL sont traduites en libellés français.
 * - Couleurs en « fond pâle + texte foncé » (light) / « fond sombre + texte clair » (dark),
 *   valeurs calculées pour respecter le contraste WCAG AA :
 *   success 5.21:1, progress 5.25:1, warning 4.84:1, danger 5.91:1,
 *   info 6.16:1, neutral 6.92:1 (fond light).
 * - Aucune bordure : le fond coloré suffit.
 */

type StatusVariant =
  | "success"
  | "progress"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

/** Enum PostgreSQL d'appartenance du statut (permet de départager les valeurs homonymes). */
export type StatusDomain =
  | "appointment"
  | "waitingRoom"
  | "session"
  | "invoice"
  | "quote"
  | "prescription"
  | "treatmentPlan"
  | "prosthesis"
  | "stock"
  | "subscription"
  | "clinic"
  | "ticket"
  | "ticketPriority";

export interface StatusBadgeProps {
  /** Valeur brute de l'enum (ex: `"in_progress"`), jamais le libellé traduit. */
  status: string;
  /**
   * Enum d'appartenance. À fournir dès qu'une valeur existe dans plusieurs enums
   * avec un libellé différent (ex: `paid` = « Payé » (séance) vs « Payée » (facture)).
   */
  domain?: StatusDomain;
  className?: string;
}

interface StatusMeta {
  label: string;
  variant: StatusVariant;
}

const variantClasses: Record<StatusVariant, string> = {
  success: "bg-[#ecfdf5] text-[#047857] dark:bg-[#065f46] dark:text-[#6ee7b7]",
  progress: "bg-[#f0fdfa] text-[#0f766e] dark:bg-[#115e59] dark:text-[#5eead4]",
  warning: "bg-[#fffbeb] text-[#b45309] dark:bg-[#92400e] dark:text-[#fcd34d]",
  danger: "bg-[#fef2f2] text-[#b91c1c] dark:bg-[#7f1d1d] dark:text-[#fca5a5]",
  info: "bg-[#eff6ff] text-[#1d4ed8] dark:bg-[#1e3a8a] dark:text-[#93c5fd]",
  neutral: "bg-[#f1f5f9] text-[#475569] dark:bg-[#334155] dark:text-[#cbd5e1]",
};

/**
 * Registre plat : libellé par défaut utilisé quand aucun `domain` n'est fourni.
 * Pour les valeurs strictement non ambiguës, il correspond exactement au mapping
 * de l'enum ; pour les valeurs homonymes (ex: `completed`, `paid`), il propose
 * le libellé générique le plus courant, surchargé par `domainStatuses` ci-dessous.
 */
const flatStatuses: Record<string, StatusMeta> = {
  // appointment_status
  scheduled: { label: "Planifié", variant: "info" },
  confirmed: { label: "Confirmé", variant: "progress" },
  in_progress: { label: "En cours", variant: "progress" },
  completed: { label: "Terminé", variant: "success" },
  cancelled: { label: "Annulé", variant: "danger" },
  no_show: { label: "Absent", variant: "danger" },
  // waiting_room_status
  waiting: { label: "En attente", variant: "warning" },
  called: { label: "Appelé", variant: "info" },
  in_treatment: { label: "En soin", variant: "progress" },
  // clinical_session_status
  pending: { label: "En attente", variant: "warning" },
  invoiced: { label: "Facturé", variant: "info" },
  paid: { label: "Payé", variant: "success" },
  // invoice_status
  draft: { label: "Brouillon", variant: "neutral" },
  sent: { label: "Envoyé", variant: "info" },
  partially_paid: { label: "Partiellement payée", variant: "warning" },
  overdue: { label: "En retard", variant: "danger" },
  // quote_status
  accepted: { label: "Accepté", variant: "success" },
  rejected: { label: "Refusé", variant: "danger" },
  expired: { label: "Expiré", variant: "danger" },
  // treatment_plan_status / stock_alert_status / clinic_subscription_status…
  active: { label: "Actif", variant: "success" },
  resolved: { label: "Résolu", variant: "success" },
  // prosthesis_order_status
  ordered: { label: "Commandée", variant: "info" },
  delivered: { label: "Livrée", variant: "success" },
  // clinic_status
  suspended: { label: "Suspendue", variant: "danger" },
  trial: { label: "Essai", variant: "info" },
  // support_ticket_status
  open: { label: "Ouvert", variant: "info" },
  closed: { label: "Clôturé", variant: "neutral" },
  // support_ticket_priority
  low: { label: "Faible", variant: "neutral" },
  medium: { label: "Moyenne", variant: "info" },
  high: { label: "Élevée", variant: "warning" },
  urgent: { label: "Urgente", variant: "danger" },
};

/**
 * Registre par domaine : mapping exact de chaque enum PostgreSQL.
 * Surcharge le registre plat dès qu'une entrée est fournie pour le domaine.
 */
const domainStatuses: Record<StatusDomain, Record<string, StatusMeta>> = {
  appointment: {
    scheduled: { label: "Planifié", variant: "info" },
    confirmed: { label: "Confirmé", variant: "progress" },
    in_progress: { label: "En cours", variant: "progress" },
    completed: { label: "Terminé", variant: "success" },
    cancelled: { label: "Annulé", variant: "danger" },
    no_show: { label: "Absent", variant: "danger" },
  },
  waitingRoom: {
    waiting: { label: "En attente", variant: "warning" },
    called: { label: "Appelé", variant: "info" },
    in_treatment: { label: "En soin", variant: "progress" },
    completed: { label: "Terminé", variant: "success" },
    no_show: { label: "Absent", variant: "danger" },
  },
  session: {
    pending: { label: "En attente", variant: "warning" },
    in_progress: { label: "En cours", variant: "progress" },
    completed: { label: "Terminé", variant: "success" },
    invoiced: { label: "Facturé", variant: "info" },
    paid: { label: "Payé", variant: "success" },
  },
  invoice: {
    draft: { label: "Brouillon", variant: "neutral" },
    sent: { label: "Envoyée", variant: "info" },
    paid: { label: "Payée", variant: "success" },
    partially_paid: { label: "Partiellement payée", variant: "warning" },
    overdue: { label: "En retard", variant: "danger" },
    cancelled: { label: "Annulée", variant: "danger" },
  },
  quote: {
    draft: { label: "Brouillon", variant: "neutral" },
    sent: { label: "Envoyé", variant: "info" },
    accepted: { label: "Accepté", variant: "success" },
    rejected: { label: "Refusé", variant: "danger" },
    expired: { label: "Expiré", variant: "warning" },
  },
  prescription: {
    active: { label: "En cours", variant: "progress" },
    completed: { label: "Terminée", variant: "success" },
    cancelled: { label: "Annulée", variant: "danger" },
  },
  treatmentPlan: {
    draft: { label: "Brouillon", variant: "neutral" },
    active: { label: "Actif", variant: "progress" },
    completed: { label: "Terminé", variant: "success" },
    cancelled: { label: "Annulé", variant: "danger" },
  },
  prosthesis: {
    ordered: { label: "Commandée", variant: "info" },
    in_progress: { label: "En fabrication", variant: "progress" },
    delivered: { label: "Livrée", variant: "success" },
    cancelled: { label: "Annulée", variant: "danger" },
  },
  stock: {
    active: { label: "Active", variant: "warning" },
    resolved: { label: "Résolue", variant: "success" },
  },
  subscription: {
    active: { label: "Actif", variant: "success" },
    cancelled: { label: "Résilié", variant: "danger" },
    expired: { label: "Expiré", variant: "danger" },
    trial: { label: "Essai", variant: "info" },
  },
  clinic: {
    active: { label: "Active", variant: "success" },
    suspended: { label: "Suspendue", variant: "danger" },
    trial: { label: "Essai", variant: "info" },
  },
  ticket: {
    open: { label: "Ouvert", variant: "info" },
    in_progress: { label: "En cours", variant: "progress" },
    resolved: { label: "Résolu", variant: "success" },
    closed: { label: "Clôturé", variant: "neutral" },
  },
  ticketPriority: {
    low: { label: "Faible", variant: "neutral" },
    medium: { label: "Moyenne", variant: "info" },
    high: { label: "Élevée", variant: "warning" },
    urgent: { label: "Urgente", variant: "danger" },
  },
};

/**
 * Résolution : `domainStatuses[domain][status] ?? flatStatuses[status] ?? repli`.
 * Une valeur inconnue (nouvel enum ajouté en base) n'est jamais jetée :
 * on affiche la valeur brute avec la variante `neutral`.
 */
function resolveStatus(status: string, domain?: StatusDomain): StatusMeta {
  const fromDomain =
    domain !== undefined ? domainStatuses[domain][status] : undefined;

  return fromDomain ?? flatStatuses[status] ?? { label: status, variant: "neutral" };
}

export function StatusBadge({ status, domain, className }: StatusBadgeProps) {
  const { label, variant } = resolveStatus(status, domain);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
    >
      {label}
    </span>
  );
}
