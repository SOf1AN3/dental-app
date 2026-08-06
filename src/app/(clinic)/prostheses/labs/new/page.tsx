import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { LabForm } from "@/components/clinic/lab-form";

export default async function NewLabPage() {
  await requireAuth();
  await getCurrentClinicId();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-cool-900">Nouveau laboratoire</h1>
      <LabForm />
    </div>
  );
}
