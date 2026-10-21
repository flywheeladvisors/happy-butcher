import "server-only";
import { Resend } from "resend";
import { z } from "zod";
import { runAgent, Trace, type AgentTool } from "./agents/runtime";
import { run, sql } from "./db";
import { requireEnv } from "./env";
import { HAPPY_BUTCHER_SYSTEM } from "./persona";
import { getItemPrices } from "./prices";
import { appendAgentRun, createAgentRun, listStores, listWatchItems, runCost, runResults } from "./queries";
import { getScrapedAd } from "./scrapedAds";
import type { PriceResult, Store, WatchItem } from "./types";
import { bestOffers, type CutOffers, type Offer } from "./everyday";
import { groupCuts } from "./cutGroup";

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

/**
 * Always per pound when we have it: "$4.99/lb", or "≈$6.48/lb" when worked out from a package
 * weight, with the package price alongside. Falls back to the package price when no weight exists.
 */
function offerPrice(o: Offer): string {
  const pkg = money(o.price);
  if (o.per_lb === null) return `${pkg ?? o.promo_text ?? "On sale"}${pkg && o.unit_price && /ea/i.test(o.unit_price) ? " ea" : ""} (package)`;
  const approx = o.per_lb_source === "derived" ? "≈" : "";
  const perLbIsThePrice = o.per_lb === o.price && o.per_lb_source === "unit";
  return `${approx}$${o.per_lb.toFixed(2)}/lb${perLbIsThePrice || !pkg ? "" : ` (${pkg} pkg)`}`;
}

/** "was $7.99/lb" for sales, where we can state it per pound. */
function offerWas(o: Offer): string {
  if (!o.on_sale || o.regular_price === null || o.regular_price <= o.price) return "";
  const approx = o.note?.includes("estimated") ? " approx." : "";
  if (o.per_lb === null || o.price === 0) return ` — was ${money(o.regular_price)}${approx}`;
  const wasPerLb = Math.round((o.regular_price / o.price) * o.per_lb * 100) / 100;
  return ` — was ${money(wasPerLb)}/lb${approx}`;
}

const tag = (o: Offer) => (o.on_sale ? "SALE" : "Everyday");

/** The headline figure: the per-lb price, or the package price when no weight is published. */
function offerMain(o: Offer): string {
  const pkg = money(o.price);
  if (o.per_lb === null) return pkg ?? o.promo_text ?? "On sale";
  return `${o.per_lb_source === "derived" ? "≈" : ""}$${o.per_lb.toFixed(2)}/lb`;
}

/** The small line under the price: what the package itself costs, or that there's no weight. */
function offerUnitNote(o: Offer): string {
  const pkg = money(o.price);
  if (o.per_lb === null) return "per package";
  if (!pkg || (o.per_lb === o.price && o.per_lb_source === "unit")) return "";
  return `${pkg} per package`;
}

export function renderEmail(cuts: CutOffers[], words: { intro: string; signoff: string }, appUrl: string | null) {
  // Beef, then Chicken, then Pork (then anything else).
  const groups = groupCuts(cuts, (c) => c.item);

  const text = [
    words.intro,
    "",
    ...groups.flatMap(({ group, items }) => [
      `== ${group.toUpperCase()} ==`,
      "",
      ...items.flatMap((c) => [
        c.item.toUpperCase() + (c.compared > 1 ? ` (best of ${c.compared} stores)` : ""),
        ...c.ranked.map((o, i) => `  ${i + 1}. ${o.store}: ${offerPrice(o)}${offerWas(o)} [${tag(o)}] ${o.product_name ?? ""}${o.on_sale && o.promo_text ? ` — ${o.promo_text}` : ""}`),
        ...c.package_sales.map((o) => `  + ${o.store}: ${offerPrice(o)}${offerWas(o)} [SALE, no weight given] ${o.product_name ?? ""}${o.promo_text ? ` — ${o.promo_text}` : ""}`),
        "",
      ]),
    ]),
    words.signoff,
    appUrl ? `\nAsk the butcher: ${appUrl}` : "",
  ].join("\n");

  const badge = (o: Offer) =>
    o.on_sale
      ? `<span class="tag" style="display:inline-block;background:#fee2e2;color:#b91c1c;border-radius:4px;padding:0 5px;font-size:10px;font-weight:600;margin-left:6px">SALE</span>`
      : `<span class="tag" style="display:inline-block;background:#f5f5f5;color:#737373;border-radius:4px;padding:0 5px;font-size:10px;margin-left:6px">EVERYDAY</span>`;
  // Each cut is its own fixed-layout table, so the four columns keep sensible widths on screen and
  // on paper, long product names wrap instead of squeezing the column, and a cut isn't split
  // across a page break when printed.
  const row = (o: Offer, label: string, best: boolean) => `<tr>
      <td class="rank">${label}</td>
      <td class="store${best ? " best" : ""}">${esc(o.store)}${badge(o)}</td>
      <td class="product">${o.product_url ? `<a href="${esc(o.product_url)}">${esc(o.product_name ?? "")}</a>` : esc(o.product_name ?? "")}${
        o.on_sale && o.promo_text ? `<div class="promo">${esc(o.promo_text)}</div>` : ""
      }</td>
      <td class="price${best ? " best" : ""}">${esc(offerMain(o))}${
        offerWas(o) ? `<div class="was">${esc(offerWas(o).replace(/^ — /, ""))}</div>` : ""
      }${offerUnitNote(o) ? `<div class="unit">${esc(offerUnitNote(o))}</div>` : ""}</td></tr>`;

  const sections = groups
    .map(
      ({ group, items }) => `<div class="group"><span class="group-label">${esc(group.toUpperCase())}</span></div>
      ${items
        .map(
          (c) => `<div class="cut">
        <div class="cut-head"><span class="cut-name">${esc(c.item)}</span>${c.compared > 1 ? `<span class="cut-note">best of ${c.compared} stores</span>` : ""}</div>
        <table class="offers" role="presentation" cellpadding="0" cellspacing="0">
          <colgroup><col class="c-rank" style="width:6%"><col class="c-store" style="width:26%"><col class="c-product" style="width:42%"><col class="c-price" style="width:26%"></colgroup>
          <tbody>
            ${c.ranked.map((o, i) => row(o, String(i + 1), i === 0 || o.per_lb === c.ranked[0].per_lb)).join("")}
            ${c.package_sales.map((o) => row(o, "+", false)).join("")}
          </tbody>
        </table>
      </div>`,
        )
        .join("")}`,
    )
    .join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>This week's best prices on your cuts</title>
<style>
  body { margin: 0; background: #efefef; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #171717; }
  .wrap { padding: 24px 12px; }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 14px; padding: 24px; box-sizing: border-box; }
  .brand { font-size: 13px; font-weight: 600; }
  .brand span { display: inline-block; background: #171717; color: #fff; border-radius: 5px; padding: 2px 5px; font-size: 10px; margin-right: 6px; }
  h1 { font-size: 20px; margin: 18px 0 8px; }
  .intro { font-size: 14px; line-height: 1.5; color: #404040; margin: 0 0 8px; }
  .group { margin: 22px 0 2px; }
  .group-label { display: inline-block; background: #171717; color: #fff; border-radius: 5px; padding: 2px 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
  .cut { margin-top: 14px; }
  .cut-head { padding-bottom: 4px; border-bottom: 1px solid #e5e5e5; }
  .cut-name { font-weight: 600; font-size: 14px; }
  .cut-note { color: #a3a3a3; font-size: 11px; margin-left: 6px; }
  /* Fixed layout: the columns keep their share of the width instead of the product name being
     squeezed by store and price cells that refuse to wrap. */
  table.offers { width: 100%; table-layout: fixed; border-collapse: collapse; }
  table.offers td { padding: 7px 8px; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  td.rank { padding-left: 0; font-size: 12px; color: #a3a3a3; }
  td.store { font-size: 13px; color: #404040; }
  td.product { font-size: 12px; color: #525252; }
  td.product a { color: #525252; }
  td.price { padding-right: 0; font-size: 13px; text-align: right; }
  td.store.best { color: #171717; font-weight: 600; }
  td.price.best { font-weight: 700; }
  .promo { color: #b91c1c; font-size: 11px; margin-top: 2px; }
  .was { color: #b91c1c; font-size: 11px; font-weight: 400; }
  .unit { color: #a3a3a3; font-size: 11px; font-weight: 400; }
  .signoff { font-size: 14px; color: #404040; margin: 20px 0 0; }
  .cta { margin: 18px 0 0; }
  .cta a { display: inline-block; background: #171717; color: #fff; text-decoration: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; }
  .footnote { font-size: 11px; color: #a3a3a3; margin: 20px 0 0; }
  @media only screen and (max-width: 520px) {
    .wrap { padding: 12px 8px; }
    .card { padding: 16px; }
    /* Narrower screen: give the store and price columns more room, and let the tag sit under the
       store name. The rank column stays (hiding a cell would shift a fixed layout's columns). */
    .c-rank { width: 5%; }
    .c-store { width: 30%; }
    .c-product { width: 36%; }
    .c-price { width: 29%; }
    table.offers td { padding: 7px 4px; }
    td.store .tag { display: block; margin-left: 0; margin-top: 2px; }
    td.product { font-size: 11px; }
  }
  @media print {
    @page { margin: 12mm; }
    body { background: #fff; }
    .wrap { padding: 0; }
    .card { max-width: none; width: auto; border: none; border-radius: 0; padding: 0; }
    .cut { page-break-inside: avoid; break-inside: avoid; }
    .group { page-break-after: avoid; break-after: avoid; }
    .cta { display: none; }
    a { color: #171717; text-decoration: none; }
  }
</style></head>
<body><div class="wrap"><div class="card">
    <div class="brand"><span>HB</span>The Happy Butcher</div>
    <h1>This week's best prices on your cuts</h1>
    <p class="intro">${esc(words.intro)}</p>
    ${sections}
    <p class="signoff">${esc(words.signoff)}</p>
    ${appUrl ? `<p class="cta"><a href="${esc(appUrl)}">Ask the butcher</a></p>` : ""}
    <p class="footnote">Ranked by the price per pound you'd pay this week, sale or everyday, at your Cary stores. "≈" means the per-lb price was worked out from the package weight. "+" rows are sales whose listing gives no weight, so they can't be compared per lb. "Approx." regular prices come from "save up to" wording in an ad.</p>
</div></div></body></html>`;

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
        ...c.ranked.map((o, i) => `  ${i + 1}. ${o.store} ${offerPrice(o)} ${tag(o)} ${o.product_name ?? ""}`),
        ...c.package_sales.map((o) => `  + ${o.store} ${offerPrice(o)} SALE (no weight given) ${o.product_name ?? ""}`),
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
  /** What the whole run cost in OpenRouter credits. */
  cost_usd: number;
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
    cost_usd: 0,
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
  await appendAgentRun(runId, trace.events, undefined, trace.totalCost);
  return { run_id: runId, cuts: cuts.map((w) => ({ id: w.id, name: w.name })) };
}

// --- Step 2: one cut (called per cut by /api/price-cut) ---------------------------------------
export async function huntCut(runId: number | null, item: WatchItem): Promise<{ results: PriceResult[]; cost: number }> {
  const trace = new Trace();
  try {
    const results = await getItemPrices(item.name, { source: "weekly", watchItemId: item.id, trace, runId });
    return { results, cost: trace.totalCost };
  } finally {
    if (runId) await appendAgentRun(runId, trace.events, undefined, trace.totalCost).catch(() => undefined);
  }
}

// --- Step 3: finish ---------------------------------------------------------------------------
export async function finishWeeklyRun(runId: number, options: { sendEmail?: boolean } = {}): Promise<WeeklyReport> {
  const trace = new Trace();
  const all = await runResults(runId);
  const report = await deliver(all, trace, runId, options.sendEmail !== false);
  await appendAgentRun(runId, trace.events, `best prices for ${report.best_offers.length} cuts (${report.deals} sales) from ${report.checks} checks`, trace.totalCost);
  report.cost_usd = await runCost(runId).catch(() => 0);
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
