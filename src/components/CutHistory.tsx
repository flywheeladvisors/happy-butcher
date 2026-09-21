"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryPoint } from "@/lib/queries";

// Distinct, fixed colors so a store keeps its color across every cut's chart.
const STORE_COLORS: Record<string, string> = {
  ALDI: "#2563eb",
  "Food Lion": "#dc2626",
  "Harris Teeter": "#16a34a",
  LIDL: "#ca8a04",
  "Lowes Foods": "#9333ea",
  Publix: "#0891b2",
  Wegmans: "#db2777",
};
const FALLBACK_COLORS = ["#ea580c", "#4f46e5", "#65a30d", "#0d9488", "#be123c"];

const DAY = 86_400_000;
const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
const weekLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

interface Point extends HistoryPoint {
  t: number;
}

function Dot(props: { cx?: number; cy?: number; payload?: Point; fill?: string }) {
  const { cx, cy, payload, fill } = props;
  if (cx === undefined || cy === undefined || !payload) return null;
  const unverified = payload.status === "unverified";
  return (
    <circle
      cx={cx}
      cy={cy}
      r={payload.on_sale ? 6 : 5}
      fill={payload.on_sale ? fill : "#fff"}
      stroke={fill}
      strokeWidth={2}
      strokeDasharray={unverified ? "2 2" : undefined}
      opacity={unverified ? 0.7 : 1}
      style={{ cursor: "pointer" }}
    />
  );
}

function PointTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  const color = STORE_COLORS[p.store] ?? "#525252";
  return (
    <div className="max-w-72 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[12px] shadow-md">
      <div className="flex items-center gap-1.5 font-medium text-neutral-900">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        {p.store}
        <span className="ml-auto font-normal text-neutral-400">week of {weekLabel(Date.parse(p.week))}</span>
      </div>
      {p.product_name && <div className="mt-1 text-neutral-600">{p.product_name}</div>}
      <div className="mt-1.5 text-[14px] font-semibold text-neutral-900">
        {money(p.price)}
        {p.unit_price && <span className="ml-1 text-[12px] font-normal text-neutral-500">({p.unit_price})</span>}
      </div>
      {p.on_sale ? (
        <div className="text-red-600">
          On sale{p.regular_price !== null ? `, reg. ${money(p.regular_price)}` : ""}
          {p.promo_text ? ` · ${p.promo_text}` : ""}
        </div>
      ) : (
        <div className="text-neutral-500">Regular price</div>
      )}
      {p.status === "unverified" && <div className="mt-1 text-amber-600">Unverified: online price, not confirmed for our store</div>}
    </div>
  );
}

export default function CutHistory({ points }: { points: HistoryPoint[] }) {
  const [showUnverified, setShowUnverified] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const all = useMemo(() => points.map((p) => ({ ...p, t: Date.parse(p.week) })), [points]);
  const shown = all.filter((p) => showUnverified || p.status === "found");
  // Only stores with something to plot get a legend chip.
  const stores = [...new Set(shown.map((p) => p.store))].sort();
  const allStores = useMemo(() => [...new Set(all.map((p) => p.store))].sort(), [all]);
  const colorFor = (store: string) => STORE_COLORS[store] ?? FALLBACK_COLORS[allStores.indexOf(store) % FALLBACK_COLORS.length];

  const visible = shown.filter((p) => !hidden.has(p.store));
  const weeks = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const latestWeek = weeks.at(-1);
  const thisWeek = all
    .filter((p) => p.t === latestWeek && (showUnverified || p.status === "found"))
    .sort((a, b) => a.price - b.price);

  if (all.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-[13px] text-neutral-500">
        No prices recorded for this cut yet. The Wednesday check adds a point per store each week, and so does asking the butcher about it in chat.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {stores.map((s) => (
          <button
            key={s}
            onClick={() => setHidden((h) => {
              const next = new Set(h);
              if (next.has(s)) next.delete(s);
              else next.add(s);
              return next;
            })}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] ${
              hidden.has(s) ? "border-neutral-200 text-neutral-400 line-through" : "border-neutral-200 bg-white text-neutral-700"
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s) }} />
            {s}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-neutral-600">
          <input type="checkbox" checked={showUnverified} onChange={(e) => setShowUnverified(e.target.checked)} />
          Include unverified website prices
        </label>
      </div>

      <div className="rounded-xl border border-neutral-100 bg-neutral-50/70 p-1">
        <div className="h-80 rounded-lg border border-neutral-100 bg-white p-3">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
              <CartesianGrid stroke="#f0f0f0" />
              <XAxis
                type="number"
                dataKey="t"
                name="Week"
                domain={[(min: number) => min - 3 * DAY, (max: number) => max + 3 * DAY]}
                ticks={weeks}
                tickFormatter={weekLabel}
                tick={{ fontSize: 12, fill: "#737373" }}
                label={{ value: "Ad week (starts Wednesday)", position: "insideBottom", offset: -5, fontSize: 11, fill: "#a3a3a3" }}
              />
              <YAxis
                type="number"
                dataKey="price"
                name="Price"
                tickFormatter={(v: number) => `$${v}`}
                tick={{ fontSize: 12, fill: "#737373" }}
                domain={[0, "auto"]}
                width={52}
              />
              <Tooltip content={<PointTooltip />} cursor={{ strokeDasharray: "3 3" }} />
              {stores
                .filter((s) => !hidden.has(s))
                .map((s) => (
                  <Scatter
                    key={s}
                    name={s}
                    data={visible.filter((p) => p.store === s)}
                    fill={colorFor(s)}
                    line={{ stroke: colorFor(s), strokeWidth: 1.5 }}
                    shape={<Dot />}
                    isAnimationActive={false}
                  />
                ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-4 px-3 py-1.5 text-[11px] text-neutral-400">
          <span>● filled = on sale</span>
          <span>○ hollow = regular price</span>
          <span>dashed = unverified</span>
          <span>Prices as advertised; check the unit in the tooltip (per lb vs. per package).</span>
        </div>
      </div>

      {weeks.length < 3 && (
        <p className="text-[12px] text-neutral-500">
          History started {weekLabel(weeks[0])}. Each Wednesday&apos;s check adds a new week, so trends show up after a few weeks.
        </p>
      )}

      <section>
        <h2 className="text-sm font-medium">Week of {latestWeek ? weekLabel(latestWeek) : "—"}, cheapest first</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-neutral-100">
          <table className="w-full text-[13px]">
            <thead className="bg-neutral-50 text-left text-[12px] text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Deal</th>
              </tr>
            </thead>
            <tbody>
              {thisWeek.map((p) => (
                <tr key={p.store} className="border-t border-neutral-100 align-top">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorFor(p.store) }} />
                    {p.store}
                  </td>
                  <td className="px-3 py-2 text-neutral-600">
                    {p.product_url ? (
                      <a href={p.product_url} target="_blank" rel="noreferrer" className="underline decoration-neutral-300 underline-offset-2">
                        {p.product_name ?? "—"}
                      </a>
                    ) : (
                      (p.product_name ?? "—")
                    )}
                    {p.status === "unverified" && <span className="ml-1 text-[11px] text-amber-600">(unverified)</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    {money(p.price)}
                    {p.unit_price && <div className="text-[11px] font-normal text-neutral-400">{p.unit_price}</div>}
                  </td>
                  <td className="px-3 py-2 text-[12px]">
                    {p.on_sale ? (
                      <span className="text-red-600">
                        Sale{p.regular_price !== null ? ` (reg. ${money(p.regular_price)})` : ""}
                      </span>
                    ) : (
                      <span className="text-neutral-400">Regular</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
