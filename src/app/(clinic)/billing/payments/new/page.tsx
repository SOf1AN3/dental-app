import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getInvoice, getUnpaidInvoicesForPatient } from "@/lib/actions/financial";
import { requirePatientOwnership } from "@/lib/guards";
import { PaymentLauncher } from "@/components/clinic/payment-launcher";
import { BackButton } from "@/components/clinic/back-button";

/**
 * Payment entry page (FACT-6). Replaces the dead `/billing/payments/new`
 * link that used to 404 from the invoice detail page.
 *
 * Modes:
 * - `?patientId=&invoiceId=` → patient locked, invoice pre-selected;
 * - `?patientId=`            → patient locked, invoice to pick;
 * - no params                → full picker (search patient, pick invoice).
 */
export default async function NewPaymentPage(props: {
  searchParams: Promise<{ patientId?: string; invoiceId?: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const { patientId, invoiceId } = await props.searchParams;

  let presetPatient: { id: string; firstName: string; lastName: string } | null = null;
  let presetInvoiceId: string | null = null;
  let presetInvoices: Awaited<ReturnType<typeof getUnpaidInvoicesForPatient>> = [];
  let warning: string | null = null;

  if (invoiceId) {
    const invoice = await getInvoice(invoiceId);
    if (!invoice) {
      warning = "Facture introuvable pour cette clinique.";
    } else if (invoice.status === "cancelled") {
      warning = "Cette facture est annulée : aucun paiement ne peut être enregistré.";
    } else if (invoice.status === "paid") {
      warning = "Cette facture est déjà entièrement payée.";
    } else {
      presetPatient = invoice.patient
        ? {
            id: invoice.patient.id,
            firstName: invoice.patient.firstName,
            lastName: invoice.patient.lastName,
          }
        : null;
      presetInvoiceId = invoice.id;
      presetInvoices = await getUnpaidInvoicesForPatient(invoice.patientId);
    }
  } else if (patientId) {
    try {
      // `requirePatientOwnership` (sans filtre d'archivage) et non
      // `requireOwnedPatient` : encaisser la dette d'un patient archivé reste
      // légitime. Cohérent avec `recordPayment`, qui applique la même règle —
      // sans quoi la page refuserait l'accès au formulaire que l'action accepte.
      const patient = await requirePatientOwnership(clinicId, patientId);
      presetPatient = {
        id: patient.id,
        firstName: patient.firstName,
        lastName: patient.lastName,
      };
      presetInvoices = await getUnpaidInvoicesForPatient(patient.id);
    } catch {
      warning = "Patient introuvable pour cette clinique.";
    }
  }

  return (
    <div>
      <div className="mb-6">
        <BackButton fallback="/billing/invoices" label="← Retour aux factures" />
        <h1 className="text-2xl font-bold text-cool-900">Nouveau paiement</h1>
      </div>

      {warning && (
        <div className="mb-6 max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          {warning}{" "}
          {presetPatient && (
            <span className="block mt-1">
              Vous pouvez tout de même enregistrer un paiement pour{" "}
              {presetPatient.lastName} {presetPatient.firstName}.
            </span>
          )}
        </div>
      )}

      <PaymentLauncher
        presetPatient={presetPatient}
        presetInvoiceId={presetInvoiceId}
        presetInvoices={presetInvoices}
      />
    </div>
  );
}
