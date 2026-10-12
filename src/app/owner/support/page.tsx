import { requirePlatformOwner } from "@/lib/auth-utils";
import { getSupportTickets } from "@/lib/actions/owner";

import { PageHeader } from "@/components/ui/page-header";
import { SupportTicketTable } from "@/components/owner/support-ticket-table";

export default async function OwnerSupportPage() {
  await requirePlatformOwner();
  const tickets = await getSupportTickets();

  return (
    <div>
      <PageHeader title="Support" description={`${tickets.length} tickets`} />

      <SupportTicketTable data={tickets} />
    </div>
  );
}
