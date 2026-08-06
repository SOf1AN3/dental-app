import { sendSubscriptionReminders } from "@/lib/cron/subscription-reminders";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return new Response("Cron désactivé", { status: 503 });
  }

  if (request.headers.get("x-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await sendSubscriptionReminders();
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
}

export const POST = GET;
