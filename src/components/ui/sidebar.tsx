"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";

export type SidebarGroup = "pilotage" | "clinique" | "suivi" | "reglages";

export interface SidebarLink {
  label: string;
  href: string;
  icon: React.ElementType;
  /** Groupe d'appartenance — sert au regroupement visuel */
  group: SidebarGroup;
}

/** Ordre d'affichage des sections dans la sidebar. */
const GROUP_ORDER: readonly SidebarGroup[] = [
  "pilotage",
  "clinique",
  "suivi",
  "reglages",
];

const GROUP_LABELS: Record<SidebarGroup, string> = {
  pilotage: "Pilotage",
  clinique: "Clinique",
  suivi: "Suivi",
  reglages: "Réglages",
};

/**
 * Détermine si une entrée de navigation correspond à la route courante.
 *
 * `pathname.startsWith(href + "/")` couvre les routes enfants :
 * sur `/patients/123` (fiche patient), `pathname` vaut `/patients/123` et non
 * `/patients`, un comparateur strict laisserait donc la fiche sans lien actif.
 * Le garde `href !== "/dashboard"` empêche un href de racine engloutir toutes
 * les routes (précaution défensive : `pathname.startsWith("/dashboard/")`
 * reste correct aujourd'hui, mais une racine "/" ne le serait pas).
 */
function isLinkActive(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(`${href}/`))
  );
}

interface SidebarNavProps {
  links: SidebarLink[];
  /**
   * Mode « icônes seules » de la barre fixe (768–1279px) : les libellés sont
   * masqués sous `xl` et réapparaissent au-delà de 1280px. L'absence de texte
   * est compensée par une info-bulle native (`title`, **réservée au mode
   * compact** : en mode déplié elle ne ferait que doubler le texte visible)
   * et par le libellé accessible du lien, qui n'est jamais retiré de
   * l'arbre d'a11y.
   *
   * Défaut `false` : le comportement pleine largeur d'origine est conservé tel
   * quel pour tout autre consommateur du composant (sidebar de l'espace
   * owner, traité par une tâche dédiée).
   */
  compact?: boolean;
}

export function SidebarNav({ links, compact = false }: SidebarNavProps) {
  const pathname = usePathname();

  // Regroupement sans dépendance externe : on parcourt une seule fois le
  // tableau et on conserve l'ordre de `GROUP_ORDER` pour le rendu.
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    links: links.filter((link) => link.group === group),
  })).filter((section) => section.links.length > 0);

  return (
    <>
      {grouped.map((section, index) => (
        <div key={section.group}>
          {/*
            `<p>` et non `<h2>`/`<h3>` : ce libellé est un simple regroupement
            visuel du menu, pas un titre sémantique de section du document.
            Des niveaux de titres ici faussent l'arbre de navigation par
            titres (screen readers) alors que la navigation est déjà décrite
            par le `<nav>` et sa liste de liens.
          */}
          <p
            className={cn(
              "px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/40",
              index === 0 ? "pt-1" : "pt-4",
              compact && "hidden xl:block"
            )}
          >
            {GROUP_LABELS[section.group]}
          </p>
          <ul className={cn("space-y-1", compact ? "px-2 xl:px-3" : "px-3")}>
            {section.links.map((link) => {
              const isActive = isLinkActive(pathname, link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive ? "page" : undefined}
                    // Info-bulle : seule source de libellé en mode compact
                    // (768–1279px), où le `<span>` est masqué par CSS.
                    // En mode déplié le texte est déjà visible → pas de
                    // `title`, sinon double lecture (voix haute + info-bulle).
                    title={compact ? link.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg py-2 text-sm transition-colors",
                      compact
                        ? "justify-center px-2 xl:justify-start xl:px-3"
                        : "justify-start px-3",
                      isActive
                        ? "bg-white/15 font-medium text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    <link.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className={cn(compact && "hidden xl:inline")}>
                      {link.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

interface SidebarBodyProps {
  links: SidebarLink[];
  /** Initials de l'utilisateur, pour le footer */
  initials: string;
  userName: string;
  /**
   * `true` pour la barre fixe (libellés masqués sous `xl`),
   * `false` pour le drawer mobile (largeur fixe 256px : tout est affiché).
   */
  compact: boolean;
  /**
   * Badge optionnel rendu **à côté du titre** de l'en-tête (ex. « Admin »
   * dans l'espace owner). Masqué en mode compact comme le titre lui-même
   * (`hidden xl:inline-flex`) : sous `xl` seule la pastille « DC » subsiste.
   */
  badge?: ReactNode;
}

/**
 * Contenu commun des deux occurrences de la sidebar (barre fixe ≥768px et
 * drawer <768px) : en-tête, navigation, pied utilisateur. Factoriser ici
 * évite de dupliquer le JSX et garantit que les deux vues restent identiques
 * (mêmes liens filtrés, même état actif, même footer).
 */
function SidebarBody({ links, initials, userName, compact, badge }: SidebarBodyProps) {
  return (
    <>
      <div
        className={cn(
          "flex h-16 items-center border-b border-white/10",
          compact ? "justify-center px-3 xl:justify-start xl:px-6" : "px-6"
        )}
      >
        {/*
          En mode compact, « DentalCare » sort du flux visuel mais reste dans
          l'arbre d'accessibilité (`sr-only` → `not-sr-only` à partir de `xl`)
          : le lecteur d'écran conserve le nom de l'application, la pastille
          « DC » ne sert qu'au regard.
        */}
        <span
          className={cn("text-xl font-bold", compact && "sr-only xl:not-sr-only")}
        >
          DentalCare
        </span>
        {badge ? (
          <span
            className={cn(
              "rounded bg-cerulean px-2 py-0.5 text-xs font-medium text-white",
              compact && "hidden xl:inline-flex"
            )}
          >
            {badge}
          </span>
        ) : null}
        {compact ? (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-sm font-bold xl:hidden"
          >
            DC
          </span>
        ) : null}
      </div>

      {/* Composant client (état actif via le hook de route courante). */}
      <nav
        aria-label="Navigation principale"
        className="flex-1 overflow-y-auto py-4"
      >
        <SidebarNav links={links} compact={compact} />
      </nav>

      <div className="border-t border-white/10 p-4">
        <div
          className={cn(
            "flex items-center gap-3",
            compact ? "justify-center xl:justify-start" : "justify-start"
          )}
        >
          {/* Avatar toujours visible ; le bloc texte n'apparaît qu'à `xl`. */}
          <div
            title={compact ? userName : undefined}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cerulean text-sm font-medium"
          >
            {initials}
          </div>
          <div className={cn("text-sm", compact && "hidden xl:block")}>
            <p className="font-medium">{userName}</p>
            <Link
              href="/select-clinic"
              className="text-xs text-white/60 transition-colors hover:text-white"
            >
              Changer de clinique
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

export interface SidebarProps {
  links: SidebarLink[];
  /** Initials de l'utilisateur, pour le footer */
  initials: string;
  userName: string;
  /**
   * Badge optionnel à côté du titre de la sidebar (ex. « Admin »).
   * Absent de l'espace clinic : comportement inchangé pour ses consommateurs.
   */
  badge?: ReactNode;
}

/**
 * Bouton burger du menu mobile.
 *
 * Rendu en **position fixe en haut à gauche** (et non inséré dans le `<header>`
 * du layout) : le layout clinic est un Server Component et l'état d'ouverture
 * vit ici, côté client. Un positionnement fixe évite tout plumbing de props à
 * travers la frontière serveur/client (props serialisables, callback
 * d'ouverture) tout en restant superposé au header (`z-40` > `z-20`) et
 * totalement retiré du flux dès 768px (`md:hidden`).
 */
export function SidebarTrigger({
  open,
  onOpen,
  triggerRef,
}: {
  open: boolean;
  onOpen: () => void;
  /**
   * Référence du bouton burger, détenue par `SidebarShell` afin d'y
   * restituer le focus après la fermeture du drawer (sinon il retombe sur
   * `<body>` et l'utilisateur clavier perd sa position).
   * Typée `RefObject<HTMLButtonElement | null>` : compatible avec
   * `useRef<HTMLButtonElement>(null)` quel que soit le générateur de
   * références de la version de React installée.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      type="button"
      ref={triggerRef}
      onClick={onOpen}
      aria-label="Ouvrir le menu"
      aria-expanded={open}
      // `aria-controls` n'est rendu que si le panneau existe réellement :
      // référencer un `id` absent de l'arbre est une erreur d'auteur ARIA
      // (relation pointant vers rien). L'état ouvert/fermé est déjà porté
      // par `aria-expanded`, qui reste présent en permanence.
      aria-controls={open ? "sidebar-drawer" : undefined}
      className="fixed left-3 top-3 z-40 rounded-lg p-2 text-cool-500 hover:bg-cool-100 md:hidden"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

/**
 * Sélecteur des éléments tabulables d'un conteneur, utilisé par le piège de
 * focus du drawer. On exclut les `disabled` et les `tabindex="-1"` (focalisables
 * programmatiquement mais non atteignables au clavier).
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Liste (document order) des éléments sur lesquels `Tab` peut atterrir. */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((element) => !element.hasAttribute("aria-hidden"));
}

/**
 * Shell responsive de la sidebar, rendu par le layout server qui ne fournit
 * que les données (liens déjà filtrés par rôle, identité de l'utilisateur).
 *
 * | Viewport        | Comportement                                          |
 * | --------------- | ----------------------------------------------------- |
 * | ≥ 1280px (`xl`) | barre fixe `w-64`, libellés visibles                  |
 * | 768–1279px      | barre fixe `w-16`, icônes seules (+ `title`)          |
 * | < 768px (`md`)  | barre fixe cachée, burger + drawer en surimpression   |
 */
export function SidebarShell({ links, initials, userName, badge }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // C1 — mémorise la valeur précédente de `open` : la restitution du focus ne
  // doit avoir lieu que sur une fermeture effective (`true → false`), sinon
  // l'effet volerait le focus au premier rendu (où `open === false`).
  const wasOpenRef = useRef(false);

  // Le drawer se referme après navigation : sinon il resterait superposé à la
  // page de destination une fois le lien cliqué.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fermeture impérative du drawer à la navigation : ne peut pas être dérivée du state
    setOpen(false);
  }, [pathname]);

  // C1 — restitution du focus au burger après fermeture (`Échap`, voile,
  // navigation ou passage ≥768px). Le panneau se démonte : sans cet appel le
  // focus retomberait sur `<body>`.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open) {
      triggerRef.current?.focus();
    }
  }, [open]);

  // Tant que le drawer est ouvert : focus initial dans le panneau, fermeture
  // par `Échap`, fermeture automatique si l'utilisateur agrandit la fenêtre
  // au-delà de 768px (le panneau est alors masqué par `md:hidden` alors que
  // l'état resterait « ouvert » — on évite un burger avec `aria-expanded`
  // orphelin au retour en mobile) et confinement de `Tab` au panneau modal.
  useEffect(() => {
    if (!open) return;

    drawerRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }

      // C2 — piège de focus : `aria-modal="true"` annonce un panneau modal,
      // or le `<main>` (rendu par le layout serveur) ne peut pas être marqué
      // `inert` depuis ce composant client. On confine donc explicitement le
      // clavier au drawer tant qu'il est ouvert.
      if (event.key !== "Tab") return;

      const panel = drawerRef.current;
      if (!panel) return;

      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Hors panneau (focus déjà échappé) ou aux bornes : on boucle.
      const isOutside = active instanceof Node && !panel.contains(active);

      if (event.shiftKey) {
        if (isOutside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (isOutside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const media = window.matchMedia("(min-width: 768px)");
    const onBreakpoint = (event: MediaQueryListEvent): void => {
      if (event.matches) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    media.addEventListener("change", onBreakpoint);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onBreakpoint);
    };
  }, [open]);

  return (
    <>
      <SidebarTrigger
        open={open}
        onOpen={() => setOpen(true)}
        triggerRef={triggerRef}
      />

      {/* Barre fixe : cachée sous 768px, compacte (`w-16`) jusqu'à 1280px,
          dépliée (`xl:w-64`) au-delà. */}
      <aside className="fixed left-0 top-0 z-30 hidden h-full w-16 flex-col bg-sidebar text-white md:flex xl:w-64">
        <SidebarBody
          links={links}
          initials={initials}
          userName={userName}
          badge={badge}
          compact
        />
      </aside>

      {/* Drawer mobile (<768px) : voile cliquable + panneau de 256px. */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Fermer le menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/50"
          />
          <aside
            id="sidebar-drawer"
            ref={drawerRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Menu de navigation"
            className="absolute left-0 top-0 flex h-full w-64 flex-col bg-sidebar text-white outline-none"
          >
            <SidebarBody
              links={links}
              initials={initials}
              userName={userName}
              badge={badge}
              compact={false}
            />
          </aside>
        </div>
      ) : null}
    </>
  );
}
