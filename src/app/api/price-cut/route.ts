import { z } from "zod";
import { Trace } from "@/lib/agents/runtime";
import { hasCronSecret } from "@/lib/cronAuth";
import { getItemPrices } from "@/lib/prices";
import { getWatchItem } from "@/lib/queries";

// One Deal Hunter + Cut Inspector job for one watched cut, in its own function invocation.
// The Wednesday check fans out to this route (one call per cut) so each cut gets its own time
// budget instead of all fifteen sharing one. Same CRON_SECRET auth as /api/weekly-check.
export const maxDuration = 300;

const Body = z.object({ watchItemId: z.number().int() });

export async function POST(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const item = await getWatchItem(parsed.data.watchItemId);
  if (!item) return Response.json({ error: "Unknown watch item" }, { status: 404 });

  const trace = new Trace();
  try {
    const results = await getItemPrices(item.name, { source: "weekly", watchItemId: item.id, trace });
    return Response.json({ results, trace: trace.events });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err), trace: trace.events }, { status: 500 });
  }
}
