import "server-only";
import { Resend } from "resend";
import { run, sql } from "./db";
import { requireEnv } from "./env";
import { chatCompletion } from "./openrouter";
import { HAPPY_BUTCHER_SYSTEM } from "./persona";
import { getItemPrices } from "./prices";
import { listStores, listWatchItems } from "./queries";
import type { PriceResult } from "./types";

// The Wednesday job: every watch item x every store, keep only what's on sale, email the rundown.
// Prices in the email come straight from the results (rendered here); the model only writes the
// Happy Butcher's intro and sign-off, so it can't misstate a number.

export interface Deal extends PriceResult {
  item: string;
}

const CONCURRENCY = 3;

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

async function butcherWords(deals: Deal[]): Promise<{ intro: string; signoff: string }> {
  const fallback = {
    intro: deals.length ? `Mornin', neighbor! The new ads just dropped and I found ${deals.length} deal${deals.length === 1 ? "" : "s"} on your cuts.` : "",
    signoff: "Happy cooking! — The Happy Butcher",
  };
  try {
    const summary = deals.map((d) => `${d.item} at ${d.store}: ${d.product_name} ${priceLine(d)} ${d.promo_text ?? ""}`).join("\n");
    const { content } = await chatCompletion({
      maxTokens: 400,
      messages: [
        { role: "system", content: HAPPY_BUTCHER_SYSTEM },
        {
          role: "user",
          content: `Write the intro and sign-off for this Wednesday's deals email. The deals table is rendered separately, so do NOT list prices or numbers. Intro: 2-3 sentences, call out the best one or two deals by cut name. Sign-off: one line. Reply as JSON {"intro": "...", "signoff": "..."}.\n\nDeals:\n${summary}`,
        },
      ],
    });
    const parsed = JSON.parse((content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (typeof parsed.intro === "string" && typeof parsed.signoff === "string") return parsed;
  } catch {
    // fall through to the canned words
  }
  return fallback;
}

export function renderEmail(deals: Deal[], words: { intro: string; signoff: string }, appUrl: string | null) {
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

  const html = `<div style="background:#efefef;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:24px">
    <div style="font-size:13px;font-weight:600"><span style="display:inline-block;background:#171717;color:#fff;border-radius:5px;padding:2px 5px;font-size:10px;margin-right:6px">HB</span>The Happy Butcher</div>
    <h1 style="font-size:20px;margin:18px 0 8px">This week's deals on your cuts</h1>
    <p style="font-size:14px;line-height:1.5;color:#404040;margin:0 0 8px">${esc(words.intro)}</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="font-size:14px;color:#404040;margin:20px 0 0">${esc(words.signoff)}</p>
    ${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;border-radius:8px;padding:8px 14px;font-size:13px">Ask the butcher</a></p>` : ""}
    <p style="font-size:11px;color:#a3a3a3;margin:20px 0 0">Prices from this week's weekly ads for your Cary stores. "Approx." regular prices come from "save up to" wording in the ad.</p>
  </div></div>`;

  return { text, html };
}

export interface WeeklyReport {
  items: number;
  stores: number;
  checks: number;
  deals: number;
  unverified: number;
  emailed: boolean;
  email_error: string | null;
  deal_list: { item: string; store: string; product: string | null; price: string }[];
}

export async function runWeeklyCheck(options: { sendEmail?: boolean } = {}): Promise<WeeklyReport> {
  const [items, stores] = await Promise.all([listWatchItems(), listStores()]);
  const perItem = await mapLimit(items, CONCURRENCY, async (w) => {
    try {
      return (await getItemPrices(w.name, { source: "weekly", watchItemId: w.id })).map((r) => ({ ...r, item: w.name }));
    } catch (err) {
      console.error(`weekly check failed for ${w.name}`, err);
      return [] as Deal[];
    }
  });
  const all = perItem.flat();
  const deals = all.filter((r) => r.status === "found" && r.on_sale);

  const report: WeeklyReport = {
    items: items.length,
    stores: stores.length,
    checks: all.length,
    deals: deals.length,
    unverified: all.filter((r) => r.status === "unverified").length,
    emailed: false,
    email_error: null,
    deal_list: deals.map((d) => ({ item: d.item, store: d.store, product: d.product_name, price: priceLine(d) })),
  };

  // Sale-only by design: no deals, no email.
  if (deals.length === 0 || options.sendEmail === false) {
    await run(sql`insert into public.notifications (summary_text, delivered, error)
      values (${deals.length ? "Email skipped (dry run)" : "No deals this week; no email sent"}, false, null)`);
    return report;
  }

  const words = await butcherWords(deals);
  const { text, html } = renderEmail(deals, words, process.env.APP_URL || null);
  try {
    const resend = new Resend(requireEnv("RESEND_API_KEY"));
    const { error } = await resend.emails.send({
      from: requireEnv("RESEND_FROM_EMAIL"),
      to: requireEnv("HOUSEHOLD_EMAIL"),
      subject: `🥩 ${deals.length} meat deal${deals.length === 1 ? "" : "s"} this week`,
      text,
      html,
    });
    if (error) throw new Error(`${error.name}: ${error.message}`);
    report.emailed = true;
  } catch (err) {
    report.email_error = err instanceof Error ? err.message : String(err);
  }
  await run(sql`insert into public.notifications (summary_text, delivered, error) values (${text}, ${report.emailed}, ${report.email_error})`);
  return report;
}
