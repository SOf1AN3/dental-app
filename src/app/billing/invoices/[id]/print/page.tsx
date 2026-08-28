import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getInvoice } from "@/lib/actions/financial";
import { getCurrentClinic } from "@/lib/actions/settings";
import { formatDate } from "@/lib/utils";
import { round2 } from "@/lib/billing-math";
import { buildA5Template } from "@/lib/document-branding";
import { A5FinancialDocument } from "@/components/clinic/a5-financial-document";
import type { FinancialDocData } from "@/components/clinic/a5-financial-document";
import { PrintToolbar } from "@/components/clinic/print-toolbar";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";

const STATUS_LABELS: Record<string, string> = {
  paid: "ACQUITTÉE",
  cancelled: "ANNULÉE",
  overdue: "EN RETARD",
  draft: "BROUILLON",
};

export default async function InvoicePrintPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const [invoice, clinic] = await Promise.all([getInvoice(id), getCurrentClinic()]);

  if (!invoice) notFound();

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const template = buildA5Template(clinic, { logoUrl, headerUrl });

  const data: FinancialDocData = {
    docType: "invoice",
    number: invoice.number,
    date: formatDate(invoice.date),
    dueLabel: invoice.dueDate ? formatDate(invoice.dueDate) : null,
    patientName: invoice.patient
      ? `${invoice.patient.lastName} ${invoice.patient.firstName}`
      : "—",
    patientPhone: invoice.patient?.phone ?? null,
    notes: invoice.notes,
    items: invoice.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate ?? 0,
      discount: item.discount ?? 0,
      total: item.total,
    })),
    subtotal: invoice.subtotal,
    taxTotal: invoice.taxTotal ?? 0,
    discountTotal: invoice.discountTotal ?? 0,
    total: invoice.total,
    paidAmount:
      invoice.payments.length > 0
        ? round2(invoice.payments.reduce((s, p) => s + p.amount, 0))
        : null,
    statusLabel: STATUS_LABELS[invoice.status] ?? null,
  };

  return (
    <>
      <PrintToolbar />
      <A5FinancialDocument template={template} data={data} />
    </>
  );
}