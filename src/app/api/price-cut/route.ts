import { z } from "zod";
import { hasCronSecret } from "@/lib/cronAuth";
import { getWatchItem } from "@/lib/queries";
import { huntCut } from "@/lib/weeklyCheck";

// One Deal Hunter + Cut Inspector job for one watched cut, in its own function call, so each cut
// of the Wednesday run gets its own time budget. Results are saved with the run id; the trace is
// appended to the run. Same CRON_SECRET auth as /api/weekly-check.
export const maxDuration = 300;

const Body = z.object({ watchItemId: z.number().int(), runId: z.number().int().nullable().optional() });

export async function POST(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const item = await getWatchItem(parsed.data.watchItemId);
  if (!item) return Response.json({ error: "Unknown watch item" }, { status: 404 });

  try {
    const results = await huntCut(parsed.data.runId ?? null, item);
    return Response.json({
      cut: item.name,
      found: results.filter((r) => r.status === "found").length,
      on_sale: results.filter((r) => r.on_sale).length,
    });
  } catch (err) {
    return Response.json({ cut: item.name, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
