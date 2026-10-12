import { PatientForm } from "@/components/clinic/patient-form";
import { PageHeader } from "@/components/ui/page-header";

export default function NewPatientPage() {
  return (
    <div>
      <PageHeader
        title="Nouveau patient"
        description="Ajouter un nouveau patient au cabinet"
      />
      <PatientForm />
    </div>
  );
}
