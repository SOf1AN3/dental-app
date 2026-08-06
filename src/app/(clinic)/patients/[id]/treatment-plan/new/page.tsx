import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { TreatmentPlanForm } from "@/components/clinic/treatment-plan-form";

export default async function NewTreatmentPlanPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  return <TreatmentPlanForm patientId={id} />;
}
