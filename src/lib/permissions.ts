/**
 * Role → abilities matrix (PAR-1). Single source of truth for "who can see /
 * do what" in a clinic. Pure module: no server-only imports, so it is usable
 * from client components (nav rendering) and unit-tested directly.
 *
 * Enforcement rules:
 * - Server actions and pages MUST check via `hasAbility` / `requireAbility`
 *   (src/lib/auth-utils.ts). Hiding nav entries is UX only, never security.
 * - When adding a protected surface, add an ability here and wire both the
 *   server check and the nav entry.
 *
 * Roles (clinic_membership.role):
 * - owner        clinic admin — everything.
 * - dentist      clinical practitioner — own clinical work + session closing;
 *                NO global reports/revenue, NO member or clinic management,
 *                NO manual invoice/quote creation (front-office duty).
 * - assistant    chairside support — clinical records, stock, waiting room.
 * - receptionist front office — patients, appointments, billing & payments.
 * - viewer       read-only observer — view screens only, no mutations.
 */
export const ROLES = ["owner", "dentist", "assistant", "receptionist", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ABILITIES = [
  // Dashboards
  "dashboard:view",
  // Patients
  "patients:view",
  "patients:manage",
  // Appointments & waiting room
  "appointments:view",
  "appointments:manage",
  "waiting:manage",
  // Clinical records (plans, notes, radiographs, medical history)
  "clinical:view",
  "clinical:manage",
  // Prescriptions
  "prescriptions:view",
  "prescriptions:manage",
  // Billing
  "billing:view",
  "billing:manage", // manual quotes/invoices/payments (front office)
  "billing:session_close", // close a session → invoice + payment
  // Stock
  "stock:view",
  "stock:manage",
  // Prosthetics lab orders
  "prostheses:view",
  "prostheses:manage",
  // Global reporting (RAP-1)
  "reports:view",
  "revenue:view_global", // global revenue figures anywhere (DB-4)
  // Clinic administration
  "members:invite", // historical policy: owner AND dentist may invite
  "members:manage", // remove members / change roles: owner only
  "settings:view",
  "settings:clinic_manage", // clinic-wide settings & branding: owner only
] as const;
export type Ability = (typeof ABILITIES)[number];

const VIEW_ONLY: readonly Ability[] = [
  "dashboard:view",
  "patients:view",
  "appointments:view",
  "clinical:view",
  "prescriptions:view",
  "billing:view",
  "stock:view",
  "prostheses:view",
  "settings:view",
];

export const ROLE_ABILITIES: Record<Role, readonly Ability[]> = {
  owner: ABILITIES,
  dentist: [
    "dashboard:view",
    "patients:view",
    "patients:manage",
    "appointments:view",
    "appointments:manage",
    "waiting:manage",
    "clinical:view",
    "clinical:manage",
    "prescriptions:view",
    "prescriptions:manage",
    "billing:view",
    "billing:session_close",
    "stock:view",
    "prostheses:view",
    "prostheses:manage",
    "members:invite",
    "settings:view",
  ],
  assistant: [
    "dashboard:view",
    "patients:view",
    "patients:manage",
    "appointments:view",
    "appointments:manage",
    "waiting:manage",
    "clinical:view",
    "clinical:manage",
    "prescriptions:view",
    "billing:view",
    "stock:view",
    "stock:manage",
    "prostheses:view",
    "prostheses:manage",
    "settings:view",
  ],
  receptionist: [
    "dashboard:view",
    "patients:view",
    "patients:manage",
    "appointments:view",
    "appointments:manage",
    "waiting:manage",
    "clinical:view",
    "prescriptions:view",
    "billing:view",
    "billing:manage",
    "billing:session_close",
    "stock:view",
    "prostheses:view",
    "settings:view",
  ],
  viewer: VIEW_ONLY,
};

export function can(role: Role, ability: Ability): boolean {
  return ROLE_ABILITIES[role]?.includes(ability) ?? false;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Nav entries mapped to the ability that grants visibility (client-side UX only). */
export const NAV_ABILITY: Record<string, Ability> = {
  "/": "dashboard:view",
  "/patients": "patients:view",
  "/appointments": "appointments:view",
  "/waiting-room": "waiting:manage",
  "/billing": "billing:view",
  "/prescriptions": "prescriptions:view",
  "/treatments": "clinical:view",
  "/stock": "stock:view",
  "/prostheses": "prostheses:view",
  "/reports": "reports:view",
  "/settings/general": "settings:view",
};
