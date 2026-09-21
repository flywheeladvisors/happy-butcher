"use client";

import Link from "next/link";
import type { AgentName } from "@/lib/agents/runtime";
import type { Store, WatchItem } from "@/lib/types";

export const AGENTS: { name: AgentName; tone: string; role: string }[] = [
  { name: "Happy Butcher", tone: "bg-neutral-900", role: "Talks to you, sends the team out" },
  { name: "Store Scout", tone: "bg-sky-500", role: "Pins down store locations and ads" },
  { name: "Deal Hunter", tone: "bg-amber-500", role: "Searches ads and store sites" },
  { name: "Cut Inspector", tone: "bg-red-500", role: "Verifies the cut and the sale" },
];
export const agentTone = (name: AgentName) => AGENTS.find((a) => a.name === name)?.tone ?? "bg-neutral-400";

export function cutGroup(name: string): "Beef" | "Chicken" | "Pork" | "Other" {
  const n = name.toLowerCase();
  if (/chicken|thigh|breast|wing|drumstick/.test(n)) return "Chicken";
  if (/pork|picnic|ham|bacon|chop/.test(n)) return "Pork";
  if (/beef|steak|ribeye|strip|broil|filet|sirloin|brisket|chuck|ground/.test(n)) return "Beef";
  return "Other";
}

export const GROUP_TONE = { Beef: "bg-red-500", Chicken: "bg-amber-500", Pork: "bg-pink-400", Other: "bg-neutral-400" } as const;

export function cutGroups(items: WatchItem[]) {
  return (["Beef", "Chicken", "Pork", "Other"] as const)
    .map((g) => ({ group: g, items: items.filter((w) => cutGroup(w.name) === g) }))
    .filter((g) => g.items.length > 0);
}

export function nextWednesday(): string {
  const d = new Date();
  const days = (3 - d.getDay() + 7) % 7 || (d.getHours() >= 8 ? 7 : 0);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-neutral-400" />
        {children}
      </span>
      {count !== undefined && <span className="rounded-md bg-sky-100 px-1.5 text-[11px] text-sky-700">{count}</span>}
    </div>
  );
}

export default function Sidebar({ stores, watchItems, activeCutId }: { stores: Store[]; watchItems: WatchItem[]; activeCutId?: number }) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-100 bg-neutral-50/60 md:flex">
      <Link href="/" className="flex items-center gap-2 px-5 py-5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-neutral-900 text-[11px] font-bold text-white">HB</span>
        <span className="text-sm font-semibold">Happy Butcher</span>
      </Link>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        <section>
          <SectionLabel>Stores</SectionLabel>
          <ul className="space-y-0.5">
            {stores.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[13px] text-neutral-700 hover:bg-white">
                <a href={s.weekly_ad_url ?? s.base_url} target="_blank" rel="noreferrer" className="truncate">
                  {s.name}
                </a>
                <span className="text-[11px] text-neutral-400">{s.city}</span>
              </li>
            ))}
            {stores.length === 0 && <li className="px-2 text-[13px] text-neutral-400">Tell the butcher where you shop.</li>}
          </ul>
        </section>

        <section>
          <SectionLabel>The crew</SectionLabel>
          <ul className="space-y-1">
            {AGENTS.map((a) => (
              <li key={a.name} className="flex items-start gap-2 px-2 py-0.5">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-[3px] ${a.tone}`} />
                <span className="min-w-0">
                  <span className="block text-[13px] text-neutral-700">{a.name}</span>
                  <span className="block text-[11px] text-neutral-400">{a.role}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionLabel count={watchItems.length}>Watch list</SectionLabel>
          <div className="space-y-3">
            {cutGroups(watchItems).map(({ group, items }) => (
              <div key={group}>
                <div className="px-2 pb-1 text-[11px] font-medium text-neutral-400">{group}</div>
                <ul className="space-y-0.5">
                  {items.map((w) => (
                    <li key={w.id}>
                      <Link
                        href={`/cuts/${w.id}`}
                        title={`Price history for ${w.name}`}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] ${
                          w.id === activeCutId ? "bg-white font-medium text-neutral-900 shadow-sm ring-1 ring-neutral-200" : "text-neutral-700 hover:bg-white"
                        }`}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-[3px] ${GROUP_TONE[group]}`} />
                        <span className="truncate">{w.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </nav>

      <div className="m-3 rounded-xl border border-neutral-200 bg-white p-3">
        <div className="text-[13px] font-medium">Wednesday check</div>
        <div className="mt-0.5 text-[12px] text-neutral-500">Every Wed, 8 AM ET. Emails only the cuts on sale.</div>
        <div className="mt-2 rounded-lg bg-neutral-100 py-1.5 text-center text-[12px] text-neutral-600">Next: {nextWednesday()}</div>
      </div>
    </aside>
  );
}
