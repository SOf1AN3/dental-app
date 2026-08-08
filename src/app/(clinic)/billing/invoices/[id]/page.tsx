import { requireAuth } from "@/lib/auth-utils";
import { getInvoice, updateInvoiceStatus } from "@/lib/actions/financial";
import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { InvoiceStatusBadge } from "@/components/clinic/invoice-status-badge";
import type { invoiceItems as invoiceItemSchema, payments as paymentSchema } from "@/lib/db/schema";

const methodLabels: Record<string, string> = {
  cash: "Espèces",
  check: "Chèque",
  card: "Carte bancaire",
  transfer: "Virement",
};

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

  const patient = await db.query.patients.findFirst({
    where: eq(patients.id, invoice.patientId),
  });

  const invoiceWithRelations = invoice as unknown as {
    items?: typeof invoiceItemSchema.$inferSelect[];
    payments?: typeof paymentSchema.$inferSelect[];
  };
  const invoiceItems = invoiceWithRelations.items;
  const invoicePayments = invoiceWithRelations.payments;

  const taxTotal = invoice.taxTotal ?? 0;
  const discountTotal = invoice.discountTotal ?? 0;

  const isTerminal = invoice.status === "paid" || invoice.status === "cancelled";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/billing/invoices"
            className="text-sm text-cerulean hover:text-cerulean/80 mb-2 inline-block"
          >
            &larr; Retour aux factures
          </Link>
          <h1 className="text-2xl font-bold text-cool-900">
            Facture {invoice.number}
          </h1>
        </div>
        <InvoiceStatusBadge status={invoice.status} className="text-sm px-3 py-1" />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-cool-500 uppercase tracking-wider">
            Informations
          </h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-cool-500">Date</span>
              <span className="text-sm font-medium text-cool-900">
                {formatDate(invoice.date)}
              </span>
            </div>
            {invoice.dueDate && (
              <div className="flex justify-between">
                <span className="text-sm text-cool-500">Échéance</span>
                <span className="text-sm font-medium text-cool-900">
                  {formatDate(invoice.dueDate)}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-sm text-cool-500">Statut</span>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-cool-500 uppercase tracking-wider">
            Patient
          </h2>
          {patient ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-cool-900">
                {patient.lastName} {patient.firstName}
              </p>
              {patient.phone && (
                <p className="text-sm text-cool-500">{patient.phone}</p>
              )}
              {patient.email && (
                <p className="text-sm text-cool-500">{patient.email}</p>
              )}
              <Link
                href={`/patients/${patient.id}`}
                className="text-sm text-cerulean hover:text-cerulean/80 inline-block"
              >
                Voir le dossier
              </Link>
            </div>
          ) : (
            <p className="text-sm text-cool-400">Patient inconnu</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <div className="px-6 py-4 border-b border-cool-200">
          <h2 className="text-base font-semibold text-cool-900">Articles</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cool-200 bg-cool-50">
                <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Description
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Qté
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Prix unitaire
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  TVA
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Remise
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {invoiceItems && invoiceItems.length > 0 ? (
                invoiceItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-cool-900">
                      {item.description}
                    </td>
                    <td className="px-4 py-3 text-right text-cool-600">
                      {item.quantity}
                    </td>
                    <td className="px-4 py-3 text-right text-cool-600">
                      {formatCurrency(item.unitPrice)}
                    </td>
                    <td className="px-4 py-3 text-right text-cool-600">
                      {(item.taxRate ?? 0) > 0 ? `${item.taxRate}%` : "-"}
                    </td>
                    <td className="px-4 py-3 text-right text-cool-600">
                      {(item.discount ?? 0) > 0 ? formatCurrency(item.discount ?? 0) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-cool-900">
                      {formatCurrency(item.total)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-cool-400"
                  >
                    Aucun article dans cette facture
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
        <div className="max-w-xs ml-auto space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-cool-500">Sous-total</span>
            <span className="text-sm text-cool-900">
              {formatCurrency(invoice.subtotal)}
            </span>
          </div>
          {taxTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-cool-500">TVA</span>
              <span className="text-sm text-cool-900">
                {formatCurrency(taxTotal)}
              </span>
            </div>
          )}
          {discountTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-cool-500">Remise</span>
              <span className="text-sm text-red-600 dark:text-red-400">
                -{formatCurrency(discountTotal)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-cool-200 pt-2">
            <span className="text-base font-semibold text-cool-900">Total</span>
            <span className="text-base font-semibold text-cool-900">
              {formatCurrency(invoice.total)}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cool-200">
          <h2 className="text-base font-semibold text-cool-900">Paiements</h2>
          <Link
            href={`/billing/payments/new?patientId=${invoice.patientId}&invoiceId=${invoice.id}`}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light transition-colors"
          >
            + Nouveau paiement
          </Link>
        </div>
        <div>
          {invoicePayments && invoicePayments.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-cool-200 bg-cool-50">
                    <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                      Méthode
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase tracking-wider">
                      Référence
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-cool-500 uppercase tracking-wider">
                      Montant
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoicePayments.map((payment) => (
                    <tr
                      key={payment.id}
                      className="border-b border-cool-100 hover:bg-cool-50 transition-colors"
                    >
                      <td className="px-4 py-3 text-cool-600">
                        {formatDate(payment.date)}
                      </td>
                      <td className="px-4 py-3 text-cool-600">
                        {methodLabels[payment.method] || payment.method}
                      </td>
                      <td className="px-4 py-3 text-cool-600">
                        {payment.reference || "-"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-cool-900">
                        {formatCurrency(payment.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-6 py-8 text-sm text-cool-400 text-center">
              Aucun paiement enregistré
            </p>
          )}
        </div>
      </div>

      {invoice.notes && (
        <div className="rounded-xl border border-cool-200 bg-white dark:bg-cool-100 p-6">
          <h2 className="text-sm font-semibold text-cool-500 uppercase tracking-wider mb-2">
            Notes
          </h2>
          <p className="text-sm text-cool-700 whitespace-pre-wrap">
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
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light transition-colors"
              >
                Envoyer
              </button>
            </form>
          )}
          {(invoice.status === "sent" ||
            invoice.status === "partially_paid" ||
            invoice.status === "overdue") && (
            <form action={handlePayStatus}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input type="hidden" name="status" value="paid" />
              <button
                type="submit"
                className="rounded-lg bg-mint px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-colors"
              >
                Marquer payée
              </button>
            </form>
          )}
          <form action={handleCancelStatus}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <input type="hidden" name="status" value="cancelled" />
            <button
              type="submit"
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Annuler
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
