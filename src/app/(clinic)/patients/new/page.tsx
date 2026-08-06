import { PatientForm } from "@/components/clinic/patient-form";

export default function NewPatientPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Nouveau patient</h1>
        <p className="text-sm text-cool-500">
          Ajouter un nouveau patient au cabinet
        </p>
      </div>
      <PatientForm />
    </div>
  );
}
