import "server-only";
import { Resend } from "resend";
import { z } from "zod";
import { runAgent, Trace, type AgentTool } from "./agents/runtime";
import { run, sql } from "./db";
import { requireEnv } from "./env";
import { HAPPY_BUTCHER_SYSTEM } from "./persona";
import { getItemPrices } from "./prices";
import { appendAgentRun, createAgentRun, listStores, listWatchItems, runResults } from "./queries";
import { getScrapedAd } from "./scrapedAds";
import type { PriceResult, Store, WatchItem } from "./types";
import { bestOffers, type CutOffers, type Offer } from "./everyday";

// The Wednesday check: email rendering here; orchestration (start / hunt / finish) below.
// Prices in the email come straight from saved results; the Butcher only writes the intro and
// sign-off, so no model can misstate a number.

export interface Deal extends PriceResult {
  item: string;
}

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

const money = (n: number | null) => (n === null || Number.isNaN(n) ? null : `$${n.toFixed(2)}`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function priceLine(d: Deal): string {
  const sale = money(d.sale_price);
  const reg = money(d.regular_price);
  if (sale && reg) return `${sale} (reg. ${reg}${d.note?.includes("estimated") ? " approx." : ""})`;
  if (sale) return sale;
  return d.promo_text ?? "On sale";
}

/** "$4.99/lb" or "$9.99 ea", plus "was $7.99" for sales. */
function offerPrice(o: Offer, perLb: boolean): string {
  const now = money(o.price) ?? o.promo_text ?? "On sale";
  const unit = perLb ? "/lb" : o.unit_price && /ea/i.test(o.unit_price) ? " ea" : "";
  const was = o.on_sale && o.regular_price !== null && o.regular_price > o.price ? ` (was ${money(o.regular_price)}${o.note?.includes("estimated") ? " approx." : ""})` : "";
  return `${now}${unit}${was}`;
}

const tag = (o: Offer) => (o.on_sale ? "SALE" : "Everyday");

export function renderEmail(cuts: CutOffers[], words: { intro: string; signoff: string }, appUrl: string | null) {
  const text = [
    words.intro,
    "",
    ...cuts.flatMap((c) => [
      c.item.toUpperCase() + (c.compared > 1 ? ` (best of ${c.compared} stores, per lb)` : ""),
      ...c.ranked.map((o, i) => `  ${i + 1}. ${o.store}: ${offerPrice(o, true)} [${tag(o)}] ${o.product_name ?? ""}${o.on_sale && o.promo_text ? ` — ${o.promo_text}` : ""}`),
      ...c.package_sales.map((o) => `  + ${o.store} (package): ${offerPrice(o, false)} [SALE] ${o.product_name ?? ""}${o.promo_text ? ` — ${o.promo_text}` : ""}`),
      "",
    ]),
    words.signoff,
    appUrl ? `\nAsk the butcher: ${appUrl}` : "",
  ].join("\n");

  const badge = (o: Offer) =>
    o.on_sale
      ? `<span style="display:inline-block;background:#fee2e2;color:#b91c1c;border-radius:4px;padding:0 5px;font-size:10px;font-weight:600;margin-left:6px">SALE</span>`
      : `<span style="display:inline-block;background:#f5f5f5;color:#737373;border-radius:4px;padding:0 5px;font-size:10px;margin-left:6px">EVERYDAY</span>`;
  const row = (o: Offer, label: string, perLb: boolean, best: boolean) => `<tr>
      <td style="padding:7px 8px 7px 0;font-size:12px;color:#a3a3a3;vertical-align:top;width:18px">${label}</td>
      <td style="padding:7px 8px 7px 0;font-size:13px;vertical-align:top;white-space:nowrap;${best ? "font-weight:600" : "color:#404040"}">${esc(o.store)}${badge(o)}</td>
      <td style="padding:7px 8px;font-size:12px;color:#525252;vertical-align:top">${o.product_url ? `<a href="${esc(o.product_url)}" style="color:#525252">${esc(o.product_name ?? "")}</a>` : esc(o.product_name ?? "")}${
        o.on_sale && o.promo_text ? `<div style="color:#b91c1c;font-size:11px;margin-top:2px">${esc(o.promo_text)}</div>` : ""
      }</td>
      <td style="padding:7px 0 7px 8px;font-size:13px;text-align:right;white-space:nowrap;vertical-align:top;${best ? "font-weight:700" : ""}">${esc(offerPrice(o, perLb))}</td></tr>`;

  const sections = cuts
    .map(
      (c) => `<tr><td colspan="4" style="padding:16px 0 4px;border-bottom:1px solid #e5e5e5">
        <span style="font-weight:600;font-size:14px">${esc(c.item)}</span>${c.compared > 1 ? `<span style="color:#a3a3a3;font-size:11px;margin-left:6px">best of ${c.compared} stores, per lb</span>` : ""}</td></tr>
      ${c.ranked.map((o, i) => row(o, String(i + 1), true, i === 0 || o.price === c.ranked[0].price)).join("")}
      ${c.package_sales.map((o) => row(o, "+", false, false)).join("")}`,
    )
    .join("");

  const html = `<div style="background:#efefef;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
  <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:24px">
    <div style="font-size:13px;font-weight:600"><span style="display:inline-block;background:#171717;color:#fff;border-radius:5px;padding:2px 5px;font-size:10px;margin-right:6px">HB</span>The Happy Butcher</div>
    <h1 style="font-size:20px;margin:18px 0 8px">This week's best prices on your cuts</h1>
    <p style="font-size:14px;line-height:1.5;color:#404040;margin:0 0 8px">${esc(words.intro)}</p>
    <table style="width:100%;border-collapse:collapse">${sections}</table>
    <p style="font-size:14px;color:#404040;margin:20px 0 0">${esc(words.signoff)}</p>
    ${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;border-radius:8px;padding:8px 14px;font-size:13px">Ask the butcher</a></p>` : ""}
    <p style="font-size:11px;color:#a3a3a3;margin:20px 0 0">Ranked by the per-lb price you'd pay this week, sale or everyday, at your Cary stores. "+" rows are sales priced per package, which can't be compared per lb. "Approx." regular prices come from "save up to" wording in an ad.</p>
  </div></div>`;

  return { text, html };
}

// ---------------------------------------------------------------------------------------------
// Orchestration. The Wednesday run has three steps so no single function call has to fit every
// cut into Vercel's time limit:
//   start  - the Butcher reviews the watch list and dispatches a Deal Hunter per cut (the run id
//            and cut list go back to the caller); store ad pages are scraped once, up front.
//   hunt   - one /api/price-cut call per cut (Deal Hunter + Cut Inspector), results saved with
//            the run id. GitHub Actions makes these calls, a few at a time.
//   finish - the Butcher reads the run's verified results and writes the rundown; the email goes out.
// runWeeklyCheck does all three in one process (local dev and dry runs).

type Words = { intro: string; signoff: string };

const START_SYSTEM = `${HAPPY_BUTCHER_SYSTEM}

It's Wednesday morning and the new weekly ads just dropped. Dispatch a Deal Hunter for every cut on the watch list (all at once is fine), then confirm the dispatch.`;

const FINISH_SYSTEM = `${HAPPY_BUTCHER_SYSTEM}

The Deal Hunters and the Cut Inspector are back with this week's verified results. Write the Wednesday email's intro (2-3 sentences in your voice, calling out the best one or two prices by cut and store, whether a sale or an everyday price) and a one-line sign-off. Do NOT write prices or numbers; the tables are added to the email for you.`;

interface DispatchCtx {
  items: WatchItem[];
  dispatched: Set<number>;
}

const dispatchTools: AgentTool<DispatchCtx>[] = [
  {
    name: "dispatch_deal_hunters",
    description: "Send a Deal Hunter (checked by the Cut Inspector) to price each of these watch-list cuts at every store.",
    parameters: {
      type: "object",
      properties: { cuts: { type: "array", items: { type: "string" }, description: "Watch-list cut names, exactly as listed" } },
      required: ["cuts"],
    },
    describe: (a) => `dispatched Deal Hunters for ${(a.cuts as string[]).length} cuts`,
    async run(args, ctx) {
      const names = (args.cuts as string[]).map((n) => n.toLowerCase());
      const chosen = ctx.items.filter((w) => names.includes(w.name.toLowerCase()));
      for (const w of chosen) ctx.dispatched.add(w.id);
      return { dispatched: chosen.map((w) => w.name), not_on_watch_list: (args.cuts as string[]).filter((n) => !chosen.some((w) => w.name.toLowerCase() === n.toLowerCase())) };
    },
  },
];

/** The Butcher decides which cuts to send Hunters for; code makes sure none are skipped. */
async function butcherDispatch(items: WatchItem[], stores: Store[], trace: Trace): Promise<WatchItem[]> {
  const ctx: DispatchCtx = { items, dispatched: new Set() };
  try {
    await runAgent(
      {
        name: "Happy Butcher",
        system: START_SYSTEM,
        tools: dispatchTools,
        maxRounds: 3,
        submit: {
          name: "confirm_dispatch",
          description: "Confirm the Deal Hunters are out.",
          parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
          parse: (raw) => z.object({ note: z.string() }).parse(raw),
        },
      },
      `Watch list:\n${items.map((w) => `- ${w.name}`).join("\n")}\n\nStores: ${stores.map((s) => s.name).join(", ")}`,
      ctx,
      trace,
    );
  } catch (err) {
    trace.add("Happy Butcher", "error", `dispatch: ${err instanceof Error ? err.message : err}`);
  }
  const skipped = items.filter((w) => !ctx.dispatched.has(w.id));
  if (skipped.length) trace.add("Happy Butcher", "handoff", `backstop: dispatching ${skipped.length} cuts the routine didn't send`);
  return items;
}

/** The Butcher reads the verified results and writes the email's intro and sign-off. */
async function butcherRundown(cuts: CutOffers[], trace: Trace): Promise<Words> {
  const fallback: Words = {
    intro: "Mornin', neighbor! The new ads just dropped. Here's where each of your cuts is cheapest this week, sale or not.",
    signoff: "Happy cooking! — The Happy Butcher",
  };
  const summary = cuts
    .map((c) =>
      [
        `${c.item}:`,
        ...c.ranked.map((o, i) => `  ${i + 1}. ${o.store} ${offerPrice(o, true)} ${tag(o)} ${o.product_name ?? ""}`),
        ...c.package_sales.map((o) => `  + ${o.store} ${offerPrice(o, false)} SALE (package) ${o.product_name ?? ""}`),
      ].join("\n"),
    )
    .join("\n");
  try {
    return await runAgent(
      {
        name: "Happy Butcher",
        system: FINISH_SYSTEM,
        tools: [],
        maxRounds: 2,
        submit: {
          name: "submit_rundown",
          description: "The email's intro and sign-off, in your voice. No prices.",
          parameters: { type: "object", properties: { intro: { type: "string" }, signoff: { type: "string" } }, required: ["intro", "signoff"] },
          parse: (raw) => z.object({ intro: z.string(), signoff: z.string() }).parse(raw),
        },
      },
      summary,
      {},
      trace,
    );
  } catch (err) {
    trace.add("Happy Butcher", "error", `rundown: ${err instanceof Error ? err.message : err}`);
    return fallback;
  }
}

export interface WeeklyReport {
  items: number;
  checks: number;
  deals: number;
  unverified: number;
  emailed: boolean;
  email_error: string | null;
  run_id: number | null;
  deal_list: { item: string; store: string; product: string | null; price: string }[];
  /** Per cut: the best-priced offers, sale or everyday. */
  best_offers: CutOffers[];
}

/** Ranks each cut's verified offers (sale or everyday), has the Butcher write it up, sends the email. */
async function deliver(all: Deal[], trace: Trace, runId: number | null, sendEmail: boolean): Promise<WeeklyReport> {
  const deals = all.filter((r) => r.status === "found" && r.on_sale);
  const cuts = bestOffers(all);
  const report: WeeklyReport = {
    items: new Set(all.map((r) => r.item)).size,
    checks: all.length,
    deals: deals.length,
    unverified: all.filter((r) => r.status === "unverified").length,
    emailed: false,
    email_error: null,
    run_id: runId,
    deal_list: deals.map((d) => ({ item: d.item, store: d.store, product: d.product_name, price: priceLine(d) })),
    best_offers: cuts,
  };

  // Nothing verified to report means no email.
  const hasNews = cuts.length > 0;
  if (!hasNews || !sendEmail) {
    await run(sql`insert into public.notifications (summary_text, delivered, error)
      values (${hasNews ? "Email skipped (dry run)" : "Nothing to report this week; no email sent"}, false, null)`);
  } else {
    const words = await butcherRundown(cuts, trace);
    const { text, html } = renderEmail(cuts, words, process.env.APP_URL || null);
    try {
      const resend = new Resend(requireEnv("RESEND_API_KEY"));
      const { error } = await resend.emails.send({
        from: requireEnv("RESEND_FROM_EMAIL"),
        to: requireEnv("HOUSEHOLD_EMAIL"),
        subject: `🥩 Best prices on your ${cuts.length} cuts this week (${deals.length} on sale)`,
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

  const outcome = report.emailed ? "sent" : !sendEmail ? "skipped (dry run)" : hasNews ? "failed" : "not needed";
  trace.add("Happy Butcher", "submit", `best prices for ${cuts.length} cuts (${deals.length} sales); email ${outcome}`);
  return report;
}

/** Scrape store ad pages once so parallel Hunters read the cache instead of each scraping. */
async function prewarmAdPages(stores: Store[]) {
  await Promise.all(stores.map((s) => getScrapedAd(s).catch(() => null)));
}

// --- Step 1: start ---------------------------------------------------------------------------
export async function startWeeklyRun(): Promise<{ run_id: number; cuts: { id: number; name: string }[] }> {
  const [items, stores] = await Promise.all([listWatchItems(), listStores()]);
  const runId = await createAgentRun("weekly", "Wednesday check (in progress)");
  const trace = new Trace();
  const [cuts] = await Promise.all([butcherDispatch(items, stores, trace), prewarmAdPages(stores)]);
  await appendAgentRun(runId, trace.events);
  return { run_id: runId, cuts: cuts.map((w) => ({ id: w.id, name: w.name })) };
}

// --- Step 2: one cut (called per cut by /api/price-cut) ---------------------------------------
export async function huntCut(runId: number | null, item: WatchItem): Promise<PriceResult[]> {
  const trace = new Trace();
  try {
    return await getItemPrices(item.name, { source: "weekly", watchItemId: item.id, trace, runId });
  } finally {
    if (runId) await appendAgentRun(runId, trace.events).catch(() => undefined);
  }
}

// --- Step 3: finish ---------------------------------------------------------------------------
export async function finishWeeklyRun(runId: number, options: { sendEmail?: boolean } = {}): Promise<WeeklyReport> {
  const trace = new Trace();
  const all = await runResults(runId);
  const report = await deliver(all, trace, runId, options.sendEmail !== false);
  await appendAgentRun(runId, trace.events, `best prices for ${report.best_offers.length} cuts (${report.deals} sales) from ${report.checks} checks`);
  return report;
}

// --- All three in one process (local dev, dry runs) --------------------------------------------
const CONCURRENCY = 8;

export async function runWeeklyCheck(options: { sendEmail?: boolean } = {}): Promise<WeeklyReport> {
  const { run_id, cuts } = await startWeeklyRun();
  const items = await listWatchItems();
  await mapLimit(cuts, CONCURRENCY, async (c) => {
    const item = items.find((w) => w.id === c.id);
    if (item) await huntCut(run_id, item).catch(() => undefined);
  });
  return finishWeeklyRun(run_id, options);
}
