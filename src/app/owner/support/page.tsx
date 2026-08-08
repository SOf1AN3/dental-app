import { requirePlatformOwner } from "@/lib/auth-utils";
import { getSupportTickets, updateTicketStatus } from "@/lib/actions/owner";
import { formatDate } from "@/lib/utils";

const statusLabels: Record<string, string> = {
  open: "Ouvert",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

const priorityColors: Record<string, string> = {
  low: "bg-cool-100 text-cool-500",
  medium: "bg-amber/10 text-amber",
  high: "bg-danger/10 text-danger",
  urgent: "bg-danger/20 text-danger",
};

async function resolveTicket(formData: FormData) {
  "use server";
  const id = formData.get("ticketId") as string;
  await updateTicketStatus(id, "resolved");
}

async function reopenTicket(formData: FormData) {
  "use server";
  const id = formData.get("ticketId") as string;
  await updateTicketStatus(id, "open");
}

export default async function OwnerSupportPage() {
  await requirePlatformOwner();
  const tickets = await getSupportTickets();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-cool-900">Support</h1>
        <p className="text-sm text-cool-500">{tickets.length} tickets</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-cool-200 bg-white dark:bg-cool-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cool-200 bg-cool-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Sujet</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Priorité</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Statut</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id} className="border-b border-cool-100 hover:bg-cool-50">
                <td className="px-4 py-3 font-medium text-cool-900">{ticket.subject}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${priorityColors[ticket.priority] || ""}`}>
                    {ticket.priority}
                  </span>
                </td>
                <td className="px-4 py-3 text-cool-600">{statusLabels[ticket.status] || ticket.status}</td>
                <td className="px-4 py-3 text-cool-600">{formatDate(ticket.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {ticket.status !== "resolved" && ticket.status !== "closed" && (
                      <form action={resolveTicket}>
                        <input type="hidden" name="ticketId" value={ticket.id} />
                        <button type="submit" className="text-sm text-mint hover:text-mint/80">
                          Résoudre
                        </button>
                      </form>
                    )}
                    {ticket.status === "resolved" && (
                      <form action={reopenTicket}>
                        <input type="hidden" name="ticketId" value={ticket.id} />
                        <button type="submit" className="text-sm text-cerulean hover:text-cerulean/80">
                          Rouvrir
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {tickets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-cool-400">
                  Aucun ticket support
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
