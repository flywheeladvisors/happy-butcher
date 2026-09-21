import { hasCronSecret } from "@/lib/cronAuth";
import { finishWeeklyRun, runWeeklyCheck, startWeeklyRun } from "@/lib/weeklyCheck";

// Wednesday check, called by GitHub Actions with `Authorization: Bearer <CRON_SECRET>`.
//   ?phase=start           -> the Butcher dispatches; returns { run_id, cuts } for the per-cut calls
//   ?phase=finish&run=<id> -> the Butcher writes up the run's results and the email is sent
//   (no phase)             -> everything in one call (local dev; may exceed the time limit on Vercel)
// ?dry=1 skips sending the email.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  try {
    const phase = params.get("phase");
    if (phase === "start") return Response.json(await startWeeklyRun());

    const report =
      phase === "finish"
        ? await finishWeeklyRun(Number(params.get("run")), { sendEmail: !dry })
        : await runWeeklyCheck({ sendEmail: !dry });
    const hasNews = report.best_offers.length > 0;
    const failed = hasNews && !dry && !report.emailed;
    return Response.json(report, { status: failed ? 502 : 200 });
  } catch (err) {
    console.error("weekly check failed", err);
    return Response.json({ error: err instanceof Error ? err.message : "Weekly check failed" }, { status: 500 });
  }
}
