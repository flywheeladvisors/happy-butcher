import "server-only";
import { Resend } from "resend";
import { z } from "zod";
import { runAgent, Trace, type AgentTool } from "./agents/runtime";
import { run, sql } from "./db";
import { requireEnv } from "./env";
import { HAPPY_BUTCHER_SYSTEM } from "./persona";
import { getItemPrices } from "./prices";
import { listStores, listWatchItems, saveAgentRun } from "./queries";
import type { PriceResult, WatchItem } from "./types";
import { lowestEveryday, type EverydayBest } from "./everyday";

// The Wednesday check, run by the agent team:
//   Happy Butcher reviews the watch list and dispatches Deal Hunters (each paired with the Cut
//   Inspector) for the cuts, reads what comes back, and writes the rundown.
//   Code guarantees every watched cut gets checked, keeps only verified sales, and renders the
//   prices into the email itself, so no model can misstate a number.

export interface Deal extends PriceResult {
  item: string;
}

const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const money = (n: number | null) => (n === null ? null : `$${n.toFixed(2)}`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function priceLine(d: Deal): string {
  const sale = money(d.sale_price);
  const reg = money(d.regular_price);
  if (sale && reg) return `${sale} (reg. ${reg}${d.note?.includes("estimated") ? " approx." : ""})`;
  if (sale) return sale;
  return d.promo_text ?? "On sale";
}

export function renderEmail(deals: Deal[], everyday: EverydayBest[], words: { intro: string; signoff: string }, appUrl: string | null) {
  const byItem = new Map<string, Deal[]>();
  for (const d of deals) byItem.set(d.item, [...(byItem.get(d.item) ?? []), d]);

  const text = [
    words.intro,
    "",
    ...[...byItem].flatMap(([item, ds]) => [
      item.toUpperCase(),
      ...ds.map((d) => `  ${d.store}: ${d.product_name ?? item} — ${priceLine(d)}${d.unit_price ? ` [${d.unit_price}]` : ""}${d.promo_text ? ` — ${d.promo_text}` : ""}${d.product_url ? `\n    ${d.product_url}` : ""}`),
      "",
    ]),
    ...(everyday.length
      ? ["LOWEST EVERYDAY PRICES (per lb, not on sale)", ...everyday.map((e) => `  ${e.item}: ${e.store} ${e.per_lb.toFixed(2)}/lb, ${e.product_name ?? ""}${e.compared > 1 ? ` (cheapest of ${e.compared} stores)` : ""}`), ""]
      : []),
    words.signoff,
    appUrl ? `\nAsk the butcher: ${appUrl}` : "",
  ].join("\n");

  const rows = [...byItem]
    .map(
      ([item, ds]) => `
      <tr><td colspan="3" style="padding:14px 0 6px;font-weight:600;font-size:14px;border-bottom:1px solid #e5e5e5">${esc(item)}</td></tr>
      ${ds
        .map(
          (d) => `<tr>
          <td style="padding:8px 8px 8px 0;font-size:13px;color:#525252;white-space:nowrap;vertical-align:top">${esc(d.store)}</td>
          <td style="padding:8px;font-size:13px;vertical-align:top">${d.product_url ? `<a href="${esc(d.product_url)}" style="color:#171717">${esc(d.product_name ?? item)}</a>` : esc(d.product_name ?? item)}${
            d.promo_text ? `<div style="color:#b91c1c;font-size:12px;margin-top:2px">${esc(d.promo_text)}</div>` : ""
          }</td>
          <td style="padding:8px 0 8px 8px;font-size:13px;text-align:right;white-space:nowrap;vertical-align:top"><strong>${esc(priceLine(d))}</strong>${
            d.unit_price ? `<div style="color:#737373;font-size:12px">${esc(d.unit_price)}</div>` : ""
          }</td></tr>`,
        )
        .join("")}`,
    )
    .join("");

  const everydayRows = everyday
    .map(
      (e) => `<tr>
        <td style="padding:8px 8px 8px 0;font-size:13px;font-weight:600;vertical-align:top;border-bottom:1px solid #f0f0f0">${esc(e.item)}</td>
        <td style="padding:8px;font-size:13px;vertical-align:top;border-bottom:1px solid #f0f0f0">${esc(e.store)}<div style="color:#737373;font-size:12px">${e.product_url ? `<a href="${esc(e.product_url)}" style="color:#737373">${esc(e.product_name ?? "")}</a>` : esc(e.product_name ?? "")}</div></td>
        <td style="padding:8px 0 8px 8px;font-size:13px;text-align:right;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f0f0f0"><strong>${e.per_lb.toFixed(2)}/lb</strong>${e.compared > 1 ? `<div style="color:#a3a3a3;font-size:11px">best of ${e.compared}</div>` : ""}</td></tr>`,
    )
    .join("");

  const html = `<div style="background:#efefef;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:24px">
    <div style="font-size:13px;font-weight:600"><span style="display:inline-block;background:#171717;color:#fff;border-radius:5px;padding:2px 5px;font-size:10px;margin-right:6px">HB</span>The Happy Butcher</div>
    <h1 style="font-size:20px;margin:18px 0 8px">This week's best prices on your cuts</h1>
    <p style="font-size:14px;line-height:1.5;color:#404040;margin:0 0 8px">${esc(words.intro)}</p>
    ${rows ? `<h2 style="font-size:15px;margin:18px 0 0">On sale this week</h2><table style="width:100%;border-collapse:collapse">${rows}</table>` : ""}
    ${everydayRows ? `<h2 style="font-size:15px;margin:24px 0 4px">Lowest everyday prices</h2><p style="font-size:12px;color:#737373;margin:0 0 4px">Cheapest regular (non-sale) price per lb across your stores.</p><table style="width:100%;border-collapse:collapse">${everydayRows}</table>` : ""}
    <p style="font-size:14px;color:#404040;margin:20px 0 0">${esc(words.signoff)}</p>
    ${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;border-radius:8px;padding:8px 14px;font-size:13px">Ask the butcher</a></p>` : ""}
    <p style="font-size:11px;color:#a3a3a3;margin:20px 0 0">Prices from this week's weekly ads and store catalogs for your Cary stores. "Approx." regular prices come from "save up to" wording in the ad.</p>
  </div></div>`;

  return { text, html };
}


interface WeeklyCtx {
  items: WatchItem[];
  trace: Trace;
  results: Map<number, Deal[]>;
}

async function checkItems(ctx: WeeklyCtx, items: WatchItem[]) {
  const todo = items.filter((w) => !ctx.results.has(w.id));
  for (const w of todo) ctx.results.set(w.id, []); // claim them so parallel dispatches don't double up
  await mapLimit(todo, CONCURRENCY, async (w) => {
    try {
      const res = await getItemPrices(w.name, { source: "weekly", watchItemId: w.id, trace: ctx.trace });
      ctx.results.set(w.id, res.map((r) => ({ ...r, item: w.name })));
    } catch (err) {
      ctx.trace.add("Deal Hunter", "error", `${w.name}: ${err instanceof Error ? err.message : err}`);
    }
  });
}

const weeklyTools: AgentTool<WeeklyCtx>[] = [
  {
    name: "dispatch_deal_hunters",
    description:
      "Send Deal Hunters (each checked by the Cut Inspector) to price these watch-list cuts at every store, in parallel. Returns each cut's verified sale deals and its lowest everyday per-lb price.",
    parameters: {
      type: "object",
      properties: { cuts: { type: "array", items: { type: "string" }, description: "Watch-list cut names, exactly as listed" } },
      required: ["cuts"],
    },
    describe: (a) => `dispatched Deal Hunters for ${(a.cuts as string[]).length} cuts`,
    async run(args, ctx) {
      const names = (args.cuts as string[]).map((n) => n.toLowerCase());
      const chosen = ctx.items.filter((w) => names.includes(w.name.toLowerCase()));
      await checkItems(ctx, chosen);
      return chosen.map((w) => {
        const results = ctx.results.get(w.id) ?? [];
        const best = lowestEveryday(results)[0];
        return {
          cut: w.name,
          deals: results
            .filter((r) => r.status === "found" && r.on_sale)
            .map((d) => ({ store: d.store, product: d.product_name, price: priceLine(d), promo: d.promo_text })),
          lowest_everyday: best ? { store: best.store, product: best.product_name, per_lb: best.per_lb } : null,
        };
      });
    },
  },
];

const WEEKLY_SYSTEM = `${HAPPY_BUTCHER_SYSTEM}

It's Wednesday morning and the new weekly ads just dropped. Your routine:
1. Dispatch Deal Hunters for every cut on the watch list (you can send them all at once).
2. Read what comes back: verified sales, plus each cut's lowest everyday price.
3. Submit the rundown: an intro (2-3 sentences in your voice, calling out the best one or two deals by cut and store, and a standout everyday price if there is one) and a one-line sign-off. Do NOT write prices or numbers; the deals table is added to the email for you.`;

export interface WeeklyReport {
  items: number;
  stores: number;
  checks: number;
  deals: number;
  unverified: number;
  emailed: boolean;
  email_error: string | null;
  run_id: number | null;
  deal_list: { item: string; store: string; product: string | null; price: string }[];
  lowest_everyday: EverydayBest[];
}

export async function runWeeklyCheck(options: { sendEmail?: boolean } = {}): Promise<WeeklyReport> {
  const [items, stores] = await Promise.all([listWatchItems(), listStores()]);
  const trace = new Trace();
  const ctx: WeeklyCtx = { items, trace, results: new Map() };

  let words = { intro: "", signoff: "Happy cooking! — The Happy Butcher" };
  try {
    words = await runAgent(
      {
        name: "Happy Butcher",
        system: WEEKLY_SYSTEM,
        tools: weeklyTools,
        maxRounds: 4,
        submit: {
          name: "submit_rundown",
          description: "The email's intro and sign-off, in your voice. No prices.",
          parameters: {
            type: "object",
            properties: { intro: { type: "string" }, signoff: { type: "string" } },
            required: ["intro", "signoff"],
          },
          parse: (raw) => z.object({ intro: z.string(), signoff: z.string() }).parse(raw),
        },
      },
      `Watch list:\n${items.map((w) => `- ${w.name}`).join("\n")}\n\nStores: ${stores.map((s) => s.name).join(", ")}`,
      ctx,
      trace,
    );
  } catch (err) {
    trace.add("Happy Butcher", "error", `weekly routine: ${err instanceof Error ? err.message : err}`);
  }

  // Every watched cut gets checked, even if the Butcher skipped one.
  const skipped = items.filter((w) => !ctx.results.has(w.id));
  if (skipped.length) {
    trace.add("Happy Butcher", "handoff", `backstop: checking ${skipped.length} cuts the routine did not dispatch`);
    await checkItems(ctx, skipped);
  }

  const all = [...ctx.results.values()].flat();
  const deals = all.filter((r) => r.status === "found" && r.on_sale);
  const everyday = lowestEveryday(all);
  if (!words.intro && (deals.length || everyday.length)) {
    words.intro = `Mornin', neighbor! The new ads just dropped and I found ${deals.length} deal${deals.length === 1 ? "" : "s"} on your cuts.`;
  }

  const report: WeeklyReport = {
    items: items.length,
    stores: stores.length,
    checks: all.length,
    deals: deals.length,
    unverified: all.filter((r) => r.status === "unverified").length,
    emailed: false,
    email_error: null,
    run_id: null,
    deal_list: deals.map((d) => ({ item: d.item, store: d.store, product: d.product_name, price: priceLine(d) })),
    lowest_everyday: everyday,
  };

  // Sales plus lowest everyday prices; nothing to report means no email.
  const hasNews = deals.length > 0 || everyday.length > 0;
  if (!hasNews || options.sendEmail === false) {
    await run(sql`insert into public.notifications (summary_text, delivered, error)
      values (${hasNews ? "Email skipped (dry run)" : "Nothing to report this week; no email sent"}, false, null)`);
  } else {
    const { text, html } = renderEmail(deals, everyday, words, process.env.APP_URL || null);
    try {
      const resend = new Resend(requireEnv("RESEND_API_KEY"));
      const { error } = await resend.emails.send({
        from: requireEnv("RESEND_FROM_EMAIL"),
        to: requireEnv("HOUSEHOLD_EMAIL"),
        subject: `🥩 ${deals.length} meat deal${deals.length === 1 ? "" : "s"} + lowest everyday prices this week`,
        text,
        html,
      });
      if (error) throw new Error(`${error.name}: ${error.message}`);
      report.emailed = true;
    } catch (err) {
      report.email_error = err instanceof Error ? err.message : String(err);
    }
    await run(sql`insert into public.notifications (summary_text, delivered, error) values (${text}, ${report.emailed}, ${report.email_error})`);
  }

  const outcome = report.emailed ? "sent" : options.sendEmail === false ? "skipped (dry run)" : hasNews ? "failed" : "not needed";
  trace.add("Happy Butcher", "submit", `${deals.length} deals; email ${outcome}`);
  report.run_id = await saveAgentRun("weekly", `${deals.length} deals from ${all.length} checks`, trace.events).catch(() => null);
  return report;
}
