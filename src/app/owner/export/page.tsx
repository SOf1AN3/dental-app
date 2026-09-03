import Link from "next/link";
import { requirePlatformOwner } from "@/lib/auth-utils";
import { getClinics } from "@/lib/actions/owner";
import { Database, Download, AlertTriangle, Building2 } from "lucide-react";
import { ClinicExportPicker } from "@/components/owner/clinic-export-picker";

export default async function OwnerExportPage() {
  await requirePlatformOwner();

  const clinics = await getClinics();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Exportation</h1>
        <p className="text-sm text-cool-500">
          Sauvegarde et migration de la base de données
        </p>
      </div>

      <div className="space-y-6">
        <div
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            Les fichiers d&apos;export contiennent les données sensibles du
            système (informations patients, mots de passe hachés, tokens
            d&apos;authentification). Téléchargez-les uniquement depuis un
            appareil de confiance et conservez-les de manière sécurisée.
          </p>
        </div>

        <div className="rounded-xl border border-cool-200 bg-white p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-cerulean/10 p-3">
              <Database className="h-6 w-6 text-cerulean" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-cool-900">
                Export complet
              </h2>
              <p className="mt-1 text-sm text-cool-500">
                Télécharge l&apos;intégralité de la plateforme : toutes les
                cliniques, patients, rendez-vous, dossiers cliniques,
                prescriptions, factures, paiements, stock, prothèses,
                abonnements et journaux d&apos;audit. Format JSON adapté à la
                sauvegarde et à la migration sur un autre serveur.
              </p>
              <Link
                href="/api/owner/export"
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cerulean px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cerulean-dark"
              >
                <Download className="h-4 w-4" />
                Télécharger la sauvegarde complète
              </Link>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-cool-200 bg-white p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-mint/10 p-3">
              <Building2 className="h-6 w-6 text-mint" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-cool-900">
                Export par clinique
              </h2>
              <p className="mt-1 text-sm text-cool-500">
                Télécharge uniquement les données d&apos;une clinique
                spécifique (patients, rendez-vous, factures, dossiers, etc.).
                Utile pour migrer ou sauvegarder un seul établissement.
              </p>
              {clinics.length > 0 ? (
                <div className="mt-4">
                  <ClinicExportPicker
                    clinics={clinics.map((c) => ({ id: c.id, name: c.name }))}
                  />
                </div>
              ) : (
                <p className="mt-4 text-sm text-cool-400">
                  Aucune clinique active à exporter.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
