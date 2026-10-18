/**
 * GET /api/dev/openings — dev-only Server-Sent Events stream that fires when
 * the openings watcher writes new artifacts (it writes the meta file last).
 * 404 outside `next dev`. Production clients revalidate on focus instead.
 */
import { watch, readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const META = join(process.cwd(), "public", "data", "openings.v2.meta.json");

function currentHash(): string | null {
  try {
    return (JSON.parse(readFileSync(META, "utf8")) as { outputHash: string }).outputHash;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    return new Response("not found", { status: 404 });
  }
  const enc = new TextEncoder();
  let last = currentHash();
  let close = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ outputHash: last });
      // watch the directory: the meta file is replaced by rename (atomic write)
      const watcher = watch(join(process.cwd(), "public", "data"), (_ev, file) => {
        if (file !== "openings.v2.meta.json") return;
        const h = currentHash();
        if (h && h !== last) {
          last = h;
          send({ outputHash: h });
        }
      });
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000);
      close = () => {
        clearInterval(ping);
        watcher.close();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", () => close());
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
