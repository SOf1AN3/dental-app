import { createHash, timingSafeEqual } from "node:crypto";
import { expireOverdueQuotes } from "@/lib/cron/expire-quotes";

/**
 * Compare le secret fourni au `CRON_SECRET` de façon constante en temps.
 *
 * `timingSafeEqual` lève une exception si les buffers diffèrent en longueur :
 * les deux côtés sont donc d'abord hashés (SHA-256), ce qui uniformise les
 * tailles à 32 o et supprime toute fuite de longueur via un early-return.
 */
function isCronSecretValid(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return new Response("Cron désactivé", { status: 503 });
  }

  if (!isCronSecretValid(request.headers.get("x-cron-secret"), secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await expireOverdueQuotes();
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
}

export const POST = GET;
