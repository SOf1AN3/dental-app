import { requireAuth } from "@/lib/auth-utils";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { getQuote } from "@/lib/actions/financial";
import { getCurrentClinic } from "@/lib/actions/settings";
import { formatDate } from "@/lib/utils";
import { buildA5Template } from "@/lib/document-branding";
import { A5FinancialDocument } from "@/components/clinic/a5-financial-document";
import type { FinancialDocData } from "@/components/clinic/a5-financial-document";
import { PrintToolbar } from "@/components/clinic/print-toolbar";
import { resolveStoredUrl } from "@/lib/storage";
import { notFound } from "next/navigation";

const STATUS_LABELS: Record<string, string> = {
  accepted: "ACCEPTÉ",
  rejected: "REFUSÉ",
  expired: "EXPIRÉ",
};

export default async function QuotePrintPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  await getCurrentClinicId();
  const { id } = await props.params;

  const [quote, clinic] = await Promise.all([getQuote(id), getCurrentClinic()]);

  if (!quote) notFound();

  const [logoUrl, headerUrl] = await Promise.all([
    resolveStoredUrl(clinic?.logoUrl ?? null),
    resolveStoredUrl(clinic?.headerUrl ?? null),
  ]);

  const template = buildA5Template(clinic, { logoUrl, headerUrl });

  const data: FinancialDocData = {
    docType: "quote",
    number: quote.number,
    date: formatDate(quote.date),
    dueLabel: quote.validUntil ? formatDate(quote.validUntil) : null,
    patientName: quote.patient
      ? `${quote.patient.lastName} ${quote.patient.firstName}`
      : "—",
    patientPhone: quote.patient?.phone ?? null,
    notes: quote.notes,
    items: quote.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate ?? 0,
      discount: item.discount ?? 0,
      total: item.total,
    })),
    subtotal: quote.subtotal,
    taxTotal: quote.taxTotal ?? 0,
    discountTotal: quote.discountTotal ?? 0,
    total: quote.total,
    paidAmount: null,
    statusLabel: STATUS_LABELS[quote.status] ?? null,
  };

  return (
    <>
      <PrintToolbar />
      <A5FinancialDocument template={template} data={data} />
    </>
  );
}