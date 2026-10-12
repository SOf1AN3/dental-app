"use client";

import { useEffect } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { closeSession, updateSessionStatus } from "@/lib/actions/session";
import { formatCurrency, formatDate } from "@/lib/utils";
import { InvoiceStatusBadge } from "@/components/clinic/invoice-status-badge";
import { PaymentForm } from "@/components/clinic/payment-form";

export interface InvoiceData {
  id: string;
  number: string;
  status: string;
  date: Date | string;
  subtotal: number;
  taxTotal: number | null;
  discountTotal: number | null;
  total: number;
  items?: Array<{
    id?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate: number | null;
    discount: number | null;
    total: number;
  }>;
  payments?: Array<{
    id?: string;
    amount: number;
    method: string;
    reference: string | null;
    date: Date | string;
  }>;
}

interface SessionInvoiceProps {
  sessionId: string;
  patientId: string;
  status: string;
  invoice: InvoiceData | null;
  prescriptionId: string | null;
}

const methodLabels: Record<string, string> = {
  cash: "Espèces",
  check: "Chèque",
  card: "Carte bancaire",
  transfer: "Virement",
};

function CloseSessionForm({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    closeSession.bind(null, sessionId),
    undefined,
  );

  useEffect(() => {
    if (state && "success" in state && state.success) router.refresh();
  }, [state, router]);

  const error = state && "error" in state ? state.error : undefined;

  return (
    <div>
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {pending ? "Clôture en cours..." : "Clore la séance"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SessionStatusAction({
  sessionId,
  status,
  label,
  pendingLabel,
  buttonClassName,
}: {
  sessionId: string;
  status: "invoiced" | "paid";
  label: string;
  pendingLabel: string;
  buttonClassName: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    updateSessionStatus.bind(null, sessionId, status),
    undefined,
  );

  useEffect(() => {
    if (state && "success" in state && state.success) router.refresh();
  }, [state, router]);

  const error = state && "error" in state ? state.error : undefined;

  return (
    <div>
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className={buttonClassName}
        >
          {pending ? pendingLabel : label}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function SessionInvoice({
  sessionId,
  patientId,
  status,
  invoice,
  prescriptionId,
}: SessionInvoiceProps) {
  if (status === "in_progress" && !invoice) {
    return (
      <div className="rounded-xl border border-border-card bg-card p-6 space-y-4">
        <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider">
          Facture
        </h2>
        <p className="text-sm text-muted-fg">
          La facture sera générée lors de la clôture de la séance
        </p>
        <CloseSessionForm sessionId={sessionId} />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="rounded-xl border border-border-card bg-card p-6">
        <h2 className="text-sm font-medium text-muted-fg uppercase tracking-wider mb-4">
          Facture
        </h2>
        <p className="text-sm text-muted-fg">Aucune facture pour cette séance</p>
      </div>
    );
  }

  const taxTotal = invoice.taxTotal ?? 0;
  const discountTotal = invoice.discountTotal ?? 0;
  const items = invoice.items ?? [];
  const payments = invoice.payments ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-card bg-card p-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">
            Facture {invoice.number}
          </h2>
          <InvoiceStatusBadge status={invoice.status} />
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={`/billing/invoices/${invoice.id}`}
            className="text-sm text-cerulean hover:text-cerulean/80"
          >
            Voir la facture
          </Link>
          {prescriptionId && (
            <Link
              href={`/prescriptions/${prescriptionId}/print`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              Imprimer l&apos;ordonnance (A5)
            </Link>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card">
        <div className="px-6 py-4 border-b border-border-card">
          <h2 className="text-base font-semibold text-foreground">Articles</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-card bg-muted">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">
                  Description
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                  Qté
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                  Prix unitaire
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                  TVA
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                  Remise
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length > 0 ? (
                items.map((item) => (
                  <tr
                    key={item.id ?? item.description}
                    className="border-b border-border hover:bg-muted transition-colors"
                  >
                    <td className="px-4 py-3 text-foreground">{item.description}</td>
                    <td className="px-4 py-3 text-right text-muted-fg">{item.quantity}</td>
                    <td className="px-4 py-3 text-right text-muted-fg">
                      {formatCurrency(item.unitPrice)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-fg">
                      {(item.taxRate ?? 0) > 0 ? `${item.taxRate}%` : "-"}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-fg">
                      {(item.discount ?? 0) > 0 ? formatCurrency(item.discount ?? 0) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-foreground">
                      {formatCurrency(item.total)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-fg">
                    Aucun article dans cette facture
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-border-card bg-card p-6">
        <div className="max-w-xs ml-auto space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-muted-fg">Sous-total</span>
            <span className="text-sm text-foreground">{formatCurrency(invoice.subtotal)}</span>
          </div>
          {taxTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">TVA</span>
              <span className="text-sm text-foreground">{formatCurrency(taxTotal)}</span>
            </div>
          )}
          {discountTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-fg">Remise</span>
              <span className="text-sm text-destructive">-{formatCurrency(discountTotal)}</span>
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
        <div className="px-6 py-4 border-b border-border-card">
          <h2 className="text-base font-semibold text-foreground">Paiements</h2>
        </div>
        {payments.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-card bg-muted">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">
                    Méthode
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-fg uppercase tracking-wider">
                    Référence
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-fg uppercase tracking-wider">
                    Montant
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.id ?? payment.reference}
                    className="border-b border-border hover:bg-muted transition-colors"
                  >
                    <td className="px-4 py-3 text-muted-fg">{formatDate(payment.date)}</td>
                    <td className="px-4 py-3 text-muted-fg">
                      {methodLabels[payment.method] || payment.method}
                    </td>
                    <td className="px-4 py-3 text-muted-fg">{payment.reference || "-"}</td>
                    <td className="px-4 py-3 text-right font-medium text-foreground">
                      {formatCurrency(payment.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-6 py-8 text-sm text-muted-fg text-center">
            Aucun paiement enregistré
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {status === "completed" && (
          <SessionStatusAction
            sessionId={sessionId}
            status="invoiced"
            label="Marquer facturée"
            pendingLabel="Enregistrement..."
            buttonClassName="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          />
        )}
        {status === "invoiced" && (
          <SessionStatusAction
            sessionId={sessionId}
            status="paid"
            label="Marquer payée"
            pendingLabel="Enregistrement..."
            buttonClassName="rounded-lg bg-mint px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          />
        )}
      </div>

      {invoice.status !== "paid" && (
        <PaymentForm patientId={patientId} invoiceId={invoice.id} />
      )}
    </div>
  );
}
