import Link from "next/link";
import { Stethoscope, Pill } from "lucide-react";
import { requireAuth } from "@/lib/auth-utils";

export const dynamic = "force-dynamic";

export default async function CataloguesPage() {
  await requireAuth();

  const catalogues = [
    {
      href: "/settings/catalogues/treatment",
      icon: Stethoscope,
      title: "Catalogue de traitements",
      description: "Liste des traitements et procédures proposés par votre clinique avec leurs prix.",
    },
    {
      href: "/settings/catalogues/medication",
      icon: Pill,
      title: "Catalogue de médicaments",
      description: "Liste des médicaments utilisés dans les ordonnances. Importez un fichier Excel ou ajoutez manuellement.",
    },
  ];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-cool-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-cool-900">Catalogues</h2>
        <p className="text-sm text-cool-500">
          Gérez les catalogues de traitements et de médicaments de votre clinique.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {catalogues.map((cat) => {
            const Icon = cat.icon;
            return (
              <Link
                key={cat.href}
                href={cat.href}
                className="group rounded-xl border border-cool-200 p-6 transition-colors hover:border-cerulean hover:bg-cool-50"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-cerulean/10 text-cerulean">
                    <Icon className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-cool-900 group-hover:text-cerulean">
                      {cat.title}
                    </h3>
                    <p className="mt-1 text-sm text-cool-500">{cat.description}</p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
