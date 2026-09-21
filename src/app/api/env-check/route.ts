import { hasCronSecret } from "@/lib/cronAuth";

// Reports which environment variables this deployment has and whether each looks like the right
// kind of value. Never returns the values. Requires `Authorization: Bearer <CRON_SECRET>`.

const CHECKS: { name: string; required: boolean; looksRight: (v: string) => boolean; hint: string }[] = [
  { name: "DATABASE_URL", required: true, looksRight: (v) => /^postgres(ql)?:\/\//.test(v), hint: "starts with postgresql://" },
  { name: "OPENROUTER_API_KEY", required: true, looksRight: (v) => v.startsWith("sk-or-"), hint: "starts with sk-or-" },
  { name: "OPENROUTER_MODEL", required: false, looksRight: (v) => v.startsWith("anthropic/"), hint: "e.g. anthropic/claude-sonnet-5" },
  { name: "TAVILY_API_KEY", required: true, looksRight: (v) => v.startsWith("tvly-"), hint: "starts with tvly-" },
  { name: "FIRECRAWL_API_KEY", required: true, looksRight: (v) => v.startsWith("fc-"), hint: "starts with fc-" },
  { name: "RESEND_API_KEY", required: true, looksRight: (v) => v.startsWith("re_"), hint: "starts with re_" },
  { name: "RESEND_FROM_EMAIL", required: true, looksRight: (v) => /@/.test(v), hint: "e.g. Happy Butcher <onboarding@resend.dev>" },
  { name: "HOUSEHOLD_EMAIL", required: true, looksRight: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), hint: "a plain email address" },
  { name: "CRON_SECRET", required: true, looksRight: (v) => v.length >= 32, hint: "long random string" },
  { name: "APP_PASSWORD", required: true, looksRight: (v) => v.length >= 6, hint: "at least 6 characters" },
  { name: "APP_URL", required: false, looksRight: (v) => /^https:\/\//.test(v), hint: "https://happy-butcher-xi.vercel.app" },
  { name: "MATCH_MODEL", required: false, looksRight: (v) => v.startsWith("anthropic/"), hint: "optional; leave unset" },
];

export async function GET(request: Request) {
  if (!hasCronSecret(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const results = CHECKS.map((c) => {
    const value = process.env[c.name];
    const status = !value ? (c.required ? "MISSING" : "not set (optional)") : c.looksRight(value) ? "ok" : `set, but doesn't look right (${c.hint})`;
    return { name: c.name, status };
  });

  // Resend: confirm the key is accepted (lists API keys' domains; sends nothing).
  let resend = "skipped (no key)";
  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const body = res ? await res.text() : "";
    resend = !res
      ? "couldn't reach Resend"
      : res.ok || /restricted_api_key/.test(body)
        ? "key accepted"
        : `key rejected (HTTP ${res.status})`;
  }

  return Response.json({
    deployment: process.env.VERCEL_ENV ?? "local",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    all_required_ok: results.every((r) => r.status === "ok" || r.status.startsWith("not set")),
    variables: results,
    resend,
  });
}
