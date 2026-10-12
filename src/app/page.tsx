import Link from "next/link";
import type { Metadata } from "next";
import {
  Bone,
  Calendar,
  Check,
  ClipboardList,
  DollarSign,
  Download,
  Globe,
  LayoutDashboard,
  Monitor,
  Package,
  Pill,
  Sofa,
  TrendingUp,
  Users,
} from "lucide-react";
import { getDesktopAppUrl } from "@/lib/desktop";

/**
 * Landing page publique.
 *
 * `/` est la seule route du site accessible sans session : `src/proxy.ts`
 * l'exempte de la redirection vers /login, et renvoie inversement tout
 * compte déjà connecté vers /dashboard — le discours commercial ne
 * s'adresse pas à quelqu'un qui est déjà dans l'application.
 *
 * Le tableau de bord, lui, vit désormais sur /dashboard.
 */
export const metadata: Metadata = {
  title: "DentalCare — Gestion de cabinet dentaire, en ligne et en bureau",
  description:
    "Agenda, dossiers patients, salle d'attente, facturation, ordonnances, stock et prothèses réunis dans une seule application. Utilisable en ligne, et bientôt installée sur votre poste.",
};

const FEATURES = [
  {
    icon: Users,
    title: "Dossiers patients",
    description:
      "Antécédents, allergies, radiographies, odontogramme et historique des soins réunis dans une fiche unique.",
  },
  {
    icon: Calendar,
    title: "Rendez-vous",
    description:
      "Agenda par praticien, planification des séances et suivi des statuts en temps réel.",
  },
  {
    icon: Sofa,
    title: "Salle d'attente",
    description:
      "Admission des patients sans rendez-vous, appel en un clic et suivi de la prise en charge.",
  },
  {
    icon: DollarSign,
    title: "Facturation",
    description:
      "Devis, factures et paiements, avec gestion de la TVA et historique comptable par clinique.",
  },
  {
    icon: Pill,
    title: "Ordonnances",
    description:
      "Prescriptions par patient, catalogue de médicaments et impression au format A5.",
  },
  {
    icon: Package,
    title: "Stock",
    description:
      "Suivi des matériaux consommables et alertes avant rupture.",
  },
  {
    icon: Bone,
    title: "Prothèses",
    description:
      "Commandes passées au laboratoire, suivi des teintes et réception des pièces.",
  },
  {
    icon: TrendingUp,
    title: "Rapports",
    description:
      "Chiffre d'affaires, activité du cabinet et export de vos données à tout moment.",
  },
] as const;

/**
 * Les icônes sont importées dynamiquement côté module ci-dessus : `as const`
 * garantit que le tableau n'est jamais muté, et préserve l'inférence de type
 * sur les props du composant présentateur.
 */
const STEPS = [
  {
    icon: LayoutDashboard,
    title: "Un tableau de bord par métier",
    description:
      "Réception, praticien et propriétaire voient chacun leurs propres indicateurs. Personne ne paie pour des chiffres dont il n'a pas l'usage.",
  },
  {
    icon: ClipboardList,
    title: "Chaque acte laisse une trace",
    description:
      "Consultations, modifications et suppressions sont journalisés. Sur un dossier médical, l'historique n'est pas une option.",
  },
  {
    icon: Check,
    title: "Multi-clinique dès l'origine",
    description:
      "Un même compte peut appartenir à plusieurs cabinets, avec des données strictement séparées.",
  },
] as const;

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Users;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-cool-200 bg-white p-6 shadow-sm dark:border-cool-200 dark:bg-cool-100">
      <div className="mb-4 inline-flex rounded-lg bg-cool-100 p-3 text-cerulean dark:bg-cool-200">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mb-1.5 text-base font-semibold text-cool-900">{title}</h3>
      <p className="text-sm leading-relaxed text-cool-600">{description}</p>
    </div>
  );
}

export default function LandingPage() {
  const desktopAppUrl = getDesktopAppUrl();

  return (
    <div className="flex min-h-screen flex-col bg-cool-50 text-cool-900 dark:bg-cool-50">
      {/* ── En-tête ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-cool-200 bg-white/80 backdrop-blur dark:border-cool-200 dark:bg-cool-100/80">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
              <span className="text-sm font-bold">D</span>
            </span>
            <span className="text-lg font-bold text-cool-900">DentalCare</span>
          </Link>

          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-cool-600 transition-colors hover:text-cool-900"
            >
              Se connecter
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light"
            >
              Créer un compte
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ──────────────────────────────────────────────── */}
        <section className="px-6 py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-cool-200 bg-white px-3 py-1 text-xs font-medium text-cool-600 dark:border-cool-200 dark:bg-cool-100">
              Solution tout-en-un pour cabinets dentaires
            </span>

            <h1 className="mt-6 text-4xl font-bold leading-tight tracking-tight text-cool-900 sm:text-5xl">
              Gérez votre cabinet, du rendez-vous à la facture.
            </h1>

            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-cool-600">
              DentalCare réunit l&apos;agenda, les dossiers patients, la salle
              d&apos;attente, la facturation, les ordonnances et le stock dans
              une seule interface. En ligne depuis n&apos;importe quel
              navigateur — et bientôt installée directement sur votre poste.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-light"
              >
                Créer un compte
                <span aria-hidden>→</span>
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-lg border border-cool-300 bg-white px-6 py-3 text-sm font-medium text-cool-700 transition-colors hover:border-cerulean hover:text-cerulean dark:border-cool-300 dark:bg-cool-100 dark:text-cool-700"
              >
                Se connecter
              </Link>
            </div>
          </div>
        </section>

        {/* ── Fonctionnalités ───────────────────────────────────── */}
        <section id="fonctionnalites" className="px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-10 max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight text-cool-900">
                Tout le cabinet dans une seule application
              </h2>
              <p className="mt-3 text-cool-600">
                Fini de jongler entre un agenda, un tableur de facturation et un
                classeur de patients. Chaque module parle aux autres.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((feature) => (
                <FeatureCard key={feature.title} {...feature} />
              ))}
            </div>
          </div>
        </section>

        {/* ── Principes ─────────────────────────────────────────── */}
        <section className="px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-10 max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight text-cool-900">
                Conçu pour la réalité d&apos;un cabinet
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {STEPS.map(({ icon: Icon, title, description }) => (
                <div
                  key={title}
                  className="rounded-xl border border-cool-200 bg-white p-6 dark:border-cool-200 dark:bg-cool-100"
                >
                  <Icon className="mb-4 h-5 w-5 text-cerulean" />
                  <h3 className="mb-1.5 text-base font-semibold text-cool-900">
                    {title}
                  </h3>
                  <p className="text-sm leading-relaxed text-cool-600">
                    {description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── En ligne / Bureau ─────────────────────────────────── */}
        <section id="application" className="px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-10 max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight text-cool-900">
                En ligne, ou installée sur votre poste
              </h2>
              <p className="mt-3 text-cool-600">
                À vous de choisir la façon de travailler qui convient le mieux à
                votre cabinet.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Version web */}
              <div className="flex flex-col rounded-xl border border-cool-200 bg-white p-8 shadow-sm dark:border-cool-200 dark:bg-cool-100">
                <div className="mb-4 inline-flex w-fit rounded-lg bg-cool-100 p-3 text-cerulean dark:bg-cool-200">
                  <Globe className="h-5 w-5" />
                </div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-cool-900">
                    Version en ligne
                  </h3>
                  <span className="rounded-full bg-mint/10 px-2 py-0.5 text-xs font-medium text-mint">
                    Disponible
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-cool-600">
                  Aucune installation. Ouvrez DentalCare dans un navigateur, au
                  poste de la réception comme sur la tablette du praticien. Vos
                  données restent synchronisées entre tous les postes.
                </p>
                <Link
                  href="/register"
                  className="mt-6 inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-light"
                >
                  Commencer maintenant
                  <span aria-hidden>→</span>
                </Link>
              </div>

              {/* Version bureau */}
              <div className="flex flex-col rounded-xl border border-cool-200 bg-white p-8 shadow-sm dark:border-cool-200 dark:bg-cool-100">
                <div className="mb-4 inline-flex w-fit rounded-lg bg-cool-100 p-3 text-cerulean dark:bg-cool-200">
                  <Monitor className="h-5 w-5" />
                </div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-cool-900">
                    Application bureau
                  </h3>
                  {desktopAppUrl ? (
                    <span className="rounded-full bg-mint/10 px-2 py-0.5 text-xs font-medium text-mint">
                      Disponible
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber/10 px-2 py-0.5 text-xs font-medium text-amber">
                      Bientôt disponible
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-cool-600">
                  Vous préférez une application installée, qui démarre sans
                  navigateur et reste utilisable hors connexion ? La version
                  bureau de DentalCare est prévue pour votre poste de travail.
                </p>

                {desktopAppUrl ? (
                  <a
                    href={desktopAppUrl}
                    className="mt-6 inline-flex w-fit items-center gap-2 rounded-lg border border-cool-300 bg-white px-5 py-2.5 text-sm font-medium text-cool-700 transition-colors hover:border-cerulean hover:text-cerulean dark:border-cool-300 dark:bg-cool-100 dark:text-cool-700"
                  >
                    <Download className="h-4 w-4" />
                    Télécharger l&apos;application
                  </a>
                ) : (
                  <span
                    aria-disabled
                    className="mt-6 inline-flex w-fit cursor-not-allowed items-center gap-2 rounded-lg border border-cool-200 bg-cool-50 px-5 py-2.5 text-sm font-medium text-cool-400 dark:border-cool-200 dark:bg-cool-100 dark:text-cool-400"
                  >
                    <Download className="h-4 w-4" />
                    Téléchargement à venir
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ── Appel à l'action final ────────────────────────────── */}
        <section className="px-6 py-20">
          <div className="mx-auto max-w-4xl rounded-2xl bg-primary px-8 py-14 text-center dark:bg-primary-light">
            <h2 className="text-3xl font-bold tracking-tight text-white">
              Prêt à simplifier la gestion de votre cabinet ?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-white/80">
              Créez votre compte et découvrez DentalCare par vous-même.
            </p>
            <Link
              href="/register"
              className="mt-7 inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-primary transition-colors hover:bg-cool-100"
            >
              Créer un compte
              <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      </main>

      {/* ── Pied de page ────────────────────────────────────────── */}
      <footer className="border-t border-cool-200 bg-white dark:border-cool-200 dark:bg-cool-100">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
              <span className="text-xs font-bold">D</span>
            </span>
            <span className="text-sm font-semibold text-cool-900">
              DentalCare
            </span>
          </div>
          <p className="text-sm text-cool-500">
            Gestion de cabinet dentaire — en ligne et en bureau.
          </p>
        </div>
      </footer>
    </div>
  );
}
