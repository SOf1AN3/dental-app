import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { LabForm } from "@/components/clinic/lab-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewLabPage() {
  await requireAuth();
  await getCurrentClinicId();

  return (
    <div>
      <PageHeader title="Nouveau laboratoire" />
      <LabForm />
    </div>
  );
}
