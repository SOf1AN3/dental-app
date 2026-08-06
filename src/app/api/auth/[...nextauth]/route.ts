import { handlers } from "@/lib/auth";

export async function GET(request: Request) {
  return handlers.GET(request as Parameters<typeof handlers.GET>[0]);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    const requestUrl = new URL(request.url);
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    if (
      originUrl.hostname !== requestUrl.hostname ||
      originUrl.port !== requestUrl.port
    ) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  return handlers.POST(request as Parameters<typeof handlers.POST>[0]);
}
