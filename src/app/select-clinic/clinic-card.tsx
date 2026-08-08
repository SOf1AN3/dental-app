import { switchClinic } from "@/lib/actions/clinic";
import type { clinics } from "@/lib/db/schema";

interface ClinicCardProps {
  clinic: typeof clinics.$inferSelect;
  role: string;
}

export function ClinicCard({ clinic, role }: ClinicCardProps) {
  return (
    <form
      action={switchClinic.bind(null, clinic.id)}
      className="cursor-pointer"
    >
      <button
        type="submit"
        className="w-full rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 text-left shadow-sm transition-all hover:border-cerulean hover:shadow-md"
      >
        <h3 className="text-lg font-semibold text-cool-900">{clinic.name}</h3>
        {clinic.wilayaCode && (
          <p className="mt-1 text-sm text-cool-500">Wilaya {clinic.wilayaCode}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {role === "owner" ? "Propriétaire" : role === "dentist" ? "Dentiste" : role === "assistant" ? "Assistant" : "Membre"}
          </span>
          {clinic.status === "trial" && (
            <span className="inline-flex items-center rounded-full bg-amber/10 px-2.5 py-0.5 text-xs font-medium text-amber">
              Essai
            </span>
          )}
        </div>
      </button>
    </form>
  );
}
