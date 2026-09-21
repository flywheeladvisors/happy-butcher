import { hasCronSecret } from "@/lib/cronAuth";
import { runWeeklyCheck } from "@/lib/weeklyCheck";

// Called Wednesday mornings by GitHub Actions with `Authorization: Bearer <CRON_SECRET>`.
// ?dry=1 runs the checks and records prices without sending the email.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    const report = await runWeeklyCheck({ sendEmail: !dry });
    const failed = report.deals > 0 && !dry && !report.emailed;
    return Response.json(report, { status: failed ? 502 : 200 });
  } catch (err) {
    console.error("weekly check failed", err);
    return Response.json({ error: err instanceof Error ? err.message : "Weekly check failed" }, { status: 500 });
  }
}
