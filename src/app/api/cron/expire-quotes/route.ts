import { expireOverdueQuotes } from "@/lib/cron/expire-quotes";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return new Response("Cron désactivé", { status: 503 });
  }

  if (request.headers.get("x-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await expireOverdueQuotes();
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
}

export const POST = GET;
