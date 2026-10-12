import { requireAuth } from "@/lib/auth-utils";
import { getInvoice, updateInvoiceStatus } from "@/lib/actions/financial";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { InvoiceStatusBadge } from "@/components/clinic/invoice-status-badge";
import { ConfirmMarkPaidButton } from "@/components/clinic/confirm-mark-paid-button";
import { BackButton } from "@/components/clinic/back-button";
import {
  BillingItemsTable,
  type BillingItemTableRow,
} from "@/components/clinic/billing-items-table";
import {
  InvoicePaymentsTable,
  type PaymentTableRow,
} from "@/components/clinic/invoice-payments-table";
import type { invoiceItems as invoiceItemSchema, payments as paymentSchema } from "@/lib/db/schema";

async function handleSendStatus(formData: FormData) {
  "use server";
  await updateInvoiceStatus(formData.get("invoiceId") as string, undefined, formData);
}

async function handlePayStatus(formData: FormData) {
  "use server";
  await updateInvoiceStatus(formData.get("invoiceId") as string, undefined, formData);
}

async function handleCancelStatus(formData: FormData) {
  "use server";
  await updateInvoiceStatus(formData.get("invoiceId") as string, undefined, formData);
}

export default async function InvoiceDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const { id } = await props.params;

  const invoice = await getInvoice(id);

  if (!invoice) {
    notFound();
  }

  // getInvoice() vérifie déjà l'appartenance de la facture à la clinique ; on
  // refiltre ici le patient au cas où il aurait changé de clinique (fuite de données).
  const clinicId = await getCurrentClinicId();
  const patient = await db.query.patients.findFirst({
    where: and(eq(patients.id, invoice.patientId), eq(patients.clinicId, clinicId)),
  });

  const invoiceWithRelations = invoice as unknown as {
    items?: typeof invoiceItemSchema.$inferSelect[];
    payments?: typeof paymentSchema.$inferSelect[];
  };
  const invoiceItems = invoiceWithRelations.items;
  const invoicePayments = invoiceWithRelations.payments;

  // Aplatissement explicite côté serveur : seules des données plates
  // (aucune fonction, aucun composant) traversent la frontière serveur/client.
  const itemRows: BillingItemTableRow[] = (invoiceItems ?? []).map((item) => ({
    id: item.id,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate,
    discount: item.discount,
    total: item.total,
  }));

  const paymentRows: PaymentTableRow[] = (invoicePayments ?? []).map(
    (payment) => ({
      id: payment.id,
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference,
      date: payment.date,
    })
  );

  const taxTotal = invoice.taxTotal ?? 0;
  const discountTotal = invoice.discountTotal ?? 0;

  const isTerminal = invoice.status === "paid" || invoice.status === "cancelled";

  return (
    <div className="space-y-6">
      <div>
        <BackButton fallback="/billing/invoices" label="← Retour aux factures" />
        <PageHeader
          title={`Facture ${invoice.number}`}
          actions={
            <>
              <Link
                href={`/billing/invoices/${invoice.id}/print`}
                target="_blank"
                className="rounded-lg border border-border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-cool-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Imprimer
              </Link>
              <InvoiceStatusBadge status={invoice.status} className="text-sm px-3 py-1" />
            </>
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-border-card bg-card p-6 space-y-3">
          <h2 className="text-sm font-semibold text-muted-fg uppercase tracking-wider">
            Informations
          </h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">Date</span>
              <span className="text-sm font-medium text-foreground">
                {formatDate(invoice.date)}
              </span>
            </div>
            {invoice.dueDate && (
              <div className="flex justify-between">
                <span className="text-sm text-muted-fg">Échéance</span>
                <span className="text-sm font-medium text-foreground">
                  {formatDate(invoice.dueDate)}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">Statut</span>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border-card bg-card p-6 space-y-3">
          <h2 className="text-sm font-semibold text-muted-fg uppercase tracking-wider">
            Patient
          </h2>
          {patient ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {patient.lastName} {patient.firstName}
              </p>
              {patient.phone && (
                <p className="text-sm text-muted-fg">{patient.phone}</p>
              )}
              {patient.email && (
                <p className="text-sm text-muted-fg">{patient.email}</p>
              )}
              <Link
                href={`/patients/${patient.id}`}
                className="text-sm text-cerulean hover:text-cerulean/80 inline-block"
              >
                Voir le dossier
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted-fg">Patient inconnu</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card">
        <div className="px-6 py-4 border-b border-border-card">
          <h2 className="text-base font-semibold text-foreground">Articles</h2>
        </div>
        <BillingItemsTable
          data={itemRows}
          emptyTitle="Aucun article dans cette facture"
          className="rounded-none border-0 bg-transparent"
        />
      </div>

      <div className="rounded-xl border border-border-card bg-card p-6">
        <div className="max-w-xs ml-auto space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-muted-fg">Sous-total</span>
            <span className="text-sm text-foreground">
              {formatCurrency(invoice.subtotal)}
            </span>
          </div>
          {taxTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">TVA</span>
              <span className="text-sm text-foreground">
                {formatCurrency(taxTotal)}
              </span>
            </div>
          )}
          {discountTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">Remise</span>
              <span className="text-sm text-destructive">
                -{formatCurrency(discountTotal)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-border-card pt-2">
            <span className="text-base font-semibold text-foreground">Total</span>
            <span className="text-base font-semibold text-foreground">
              {formatCurrency(invoice.total)}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-card">
          <h2 className="text-base font-semibold text-foreground">Paiements</h2>
          <Link
            href={`/billing/payments/new?patientId=${invoice.patientId}&invoiceId=${invoice.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Nouveau paiement
          </Link>
        </div>
        <InvoicePaymentsTable
          data={paymentRows}
          className="rounded-none border-0 bg-transparent"
        />
      </div>

      {invoice.notes && (
        <div className="rounded-xl border border-border-card bg-card p-6">
          <h2 className="text-sm font-semibold text-muted-fg uppercase tracking-wider mb-2">
            Notes
          </h2>
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {invoice.notes}
          </p>
        </div>
      )}

      {!isTerminal && (
        <div className="flex items-center gap-3">
          {invoice.status === "draft" && (
            <form action={handleSendStatus}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input type="hidden" name="status" value="sent" />
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                Envoyer
              </button>
            </form>
          )}
          {(invoice.status === "sent" ||
            invoice.status === "partially_paid" ||
            invoice.status === "overdue" ||
            invoice.status === "draft") && (
            <ConfirmMarkPaidButton
              action={handlePayStatus}
              invoiceId={invoice.id}
              isDraft={invoice.status === "draft"}
            />
          )}
          <form action={handleCancelStatus}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <input type="hidden" name="status" value="cancelled" />
            <button
              type="submit"
              className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Annuler
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
