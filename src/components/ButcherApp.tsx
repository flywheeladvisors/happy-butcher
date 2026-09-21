"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentName, TraceEvent } from "@/lib/agents/runtime";
import type { DashboardStats } from "@/lib/queries";
import type { Store, WatchItem } from "@/lib/types";

interface Summary {
  stats: DashboardStats;
  stores: Store[];
  watchItems: WatchItem[];
}

interface Message {
  role: "user" | "assistant";
  content: string;
  trace?: TraceEvent[];
  error?: boolean;
}

const AGENTS: { name: AgentName; tone: string; role: string }[] = [
  { name: "Happy Butcher", tone: "bg-neutral-900", role: "Talks to you, sends the team out" },
  { name: "Store Scout", tone: "bg-sky-500", role: "Pins down store locations and ads" },
  { name: "Deal Hunter", tone: "bg-amber-500", role: "Searches ads and store sites" },
  { name: "Cut Inspector", tone: "bg-red-500", role: "Verifies the cut and the sale" },
];
const agentTone = (name: AgentName) => AGENTS.find((a) => a.name === name)?.tone ?? "bg-neutral-400";

const QUICK_START = [
  { title: "Ribeye check", tone: "bg-red-500", prompt: "What's ribeye running at Harris Teeter right now?", blurb: "Current price, sale or not, with the link." },
  { title: "Chicken deals", tone: "bg-amber-500", prompt: "Is anybody running a sale on boneless chicken thighs this week?", blurb: "Checks every saved store at once." },
  { title: "My stores", tone: "bg-sky-500", prompt: "Which stores are you keeping an eye on for us?", blurb: "Add more any time; it never replaces the list." },
  { title: "Watch list", tone: "bg-emerald-500", prompt: "What's on my watch list right now?", blurb: "The cuts the Wednesday check looks for." },
];

function cutGroup(name: string): "Beef" | "Chicken" | "Pork" | "Other" {
  const n = name.toLowerCase();
  if (/chicken|thigh|breast|wing|drumstick/.test(n)) return "Chicken";
  if (/pork|picnic|ham|bacon|chop/.test(n)) return "Pork";
  if (/beef|steak|ribeye|strip|broil|filet|sirloin|brisket|chuck|ground/.test(n)) return "Beef";
  return "Other";
}

const GROUP_TONE = { Beef: "bg-red-500", Chicken: "bg-amber-500", Pork: "bg-pink-400", Other: "bg-neutral-400" } as const;

function formatWhen(iso: string | null): string {
  if (!iso) return "Not yet";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function nextWednesday(): string {
  const d = new Date();
  const days = (3 - d.getDay() + 7) % 7 || (d.getHours() >= 8 ? 7 : 0);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function ButcherApp({ initial }: { initial: Summary }) {
  const [summary, setSummary] = useState(initial);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function refreshSummary() {
    const res = await fetch("/api/summary", { cache: "no-store" });
    if (res.ok) setSummary(await res.json());
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const history: Message[] = [...messages, { role: "user", content }];
    setMessages(history);
    setDraft("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setMessages([...history, { role: "assistant", content: data.reply, trace: data.trace }]);
      if (data.trace?.length) void refreshSummary();
    } catch (err) {
      setMessages([
        ...history,
        { role: "assistant", error: true, content: `Something went wrong behind the counter: ${err instanceof Error ? err.message : err}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const groups = (["Beef", "Chicken", "Pork", "Other"] as const)
    .map((g) => ({ group: g, items: summary.watchItems.filter((w) => cutGroup(w.name) === g) }))
    .filter((g) => g.items.length > 0);

  const stats = [
    { label: "Stores", value: summary.stats.stores, foot: summary.stores[0] ? `${summary.stores[0].city}, ${summary.stores[0].state}` : "None yet" },
    { label: "Cuts watched", value: summary.stats.watchItems, foot: `${groups.length} groups` },
    { label: "Deals (7 days)", value: summary.stats.dealsThisWeek, foot: "on sale right now", accent: true },
    { label: "Last Wednesday check", value: formatWhen(summary.stats.lastWeeklyCheck), foot: `Next: ${nextWednesday()}, 8 AM` },
  ];

  return (
    <div className="h-dvh p-0 md:p-6 lg:p-10">
      <div className="mx-auto flex h-full max-w-7xl overflow-hidden bg-white md:rounded-2xl md:border md:border-neutral-200 md:shadow-sm">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-100 bg-neutral-50/60 md:flex">
          <div className="flex items-center gap-2 px-5 py-5">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-neutral-900 text-[11px] font-bold text-white">HB</span>
            <span className="text-sm font-semibold">Happy Butcher</span>
          </div>

          <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
            <section>
              <SectionLabel>Stores</SectionLabel>
              <ul className="space-y-0.5">
                {summary.stores.map((s) => (
                  <li key={s.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[13px] text-neutral-700 hover:bg-white">
                    <a href={s.weekly_ad_url ?? s.base_url} target="_blank" rel="noreferrer" className="truncate">
                      {s.name}
                    </a>
                    <span className="text-[11px] text-neutral-400">{s.city}</span>
                  </li>
                ))}
                {summary.stores.length === 0 && <li className="px-2 text-[13px] text-neutral-400">Tell the butcher where you shop.</li>}
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
              <SectionLabel count={summary.watchItems.length}>Watch list</SectionLabel>
              <div className="space-y-3">
                {groups.map(({ group, items }) => (
                  <div key={group}>
                    <div className="px-2 pb-1 text-[11px] font-medium text-neutral-400">{group}</div>
                    <ul className="space-y-0.5">
                      {items.map((w) => (
                        <li key={w.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] text-neutral-700">
                          <span className={`h-2 w-2 shrink-0 rounded-[3px] ${GROUP_TONE[group]}`} />
                          <span className="truncate">{w.name}</span>
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
            <div className="mt-0.5 text-[12px] text-neutral-500">
              Every Wed, 8 AM ET. Emails only the cuts on sale.
            </div>
            <div className="mt-2 rounded-lg bg-neutral-100 py-1.5 text-center text-[12px] text-neutral-600">Next: {nextWednesday()}</div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 md:px-6">
            <div className="flex items-center gap-2 text-[13px] text-neutral-500">
              <span className="md:hidden grid h-6 w-6 place-items-center rounded-md bg-neutral-900 text-[11px] font-bold text-white">HB</span>
              <span>Butcher counter</span>
            </div>
            {messages.length > 0 && (
              <button
                onClick={() => setMessages([])}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50"
              >
                New chat
              </button>
            )}
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <div className="mx-auto max-w-4xl">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">Howdy, neighbor!</h1>
                  <p className="mt-1 text-[13px] text-neutral-500">
                    I watch your stores&apos; weekly ads for the meats you actually buy, and only holler when something&apos;s a real deal.
                  </p>
                </div>
                <span className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600">
                  {new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl border border-neutral-100 bg-neutral-50/70 p-1">
                    <div className="rounded-lg border border-neutral-100 bg-white px-3 py-3">
                      <div className="text-[12px] text-neutral-500">{s.label}</div>
                      <div className="mt-1 text-xl font-semibold tracking-tight">{s.value}</div>
                    </div>
                    <div className={`px-3 py-1.5 text-[11px] ${s.accent ? "text-emerald-600" : "text-neutral-400"}`}>{s.foot}</div>
                  </div>
                ))}
              </div>

              <div className="hatch my-6 h-3" />

              {messages.length === 0 ? (
                <section>
                  <h2 className="text-sm font-medium">Quick start</h2>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {QUICK_START.map((q) => (
                      <div key={q.title} className="flex flex-col rounded-xl border border-neutral-100 bg-neutral-50/70 p-1">
                        <div className="flex-1 rounded-lg border border-neutral-100 bg-white p-3">
                          <div className="flex items-center gap-2 text-[13px] font-medium">
                            <span className={`h-3 w-3 rounded-[4px] ${q.tone}`} />
                            {q.title}
                          </div>
                          <p className="mt-1 text-[12px] text-neutral-500">{q.blurb}</p>
                          <p className="mt-2 text-[12px] italic text-neutral-700">&ldquo;{q.prompt}&rdquo;</p>
                        </div>
                        <button
                          onClick={() => send(q.prompt)}
                          disabled={busy}
                          className="m-1 rounded-lg border border-neutral-200 bg-white py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                        >
                          Ask this
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : (
                <section className="space-y-5">
                  {messages.map((m, i) => (
                    <MessageBubble key={i} message={m} />
                  ))}
                  {busy && (
                    <div className="flex items-center gap-2 text-[13px] text-neutral-500">
                      <span className="grid h-7 w-7 place-items-center rounded-lg bg-neutral-900 text-[10px] font-bold text-white">HB</span>
                      <span className="animate-pulse">Checking the meat case... price checks can take a minute.</span>
                    </div>
                  )}
                </section>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            className="border-t border-neutral-100 px-4 py-3 md:px-8"
          >
            <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-xl border border-neutral-200 bg-white p-1.5 focus-within:border-neutral-400">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                rows={1}
                placeholder="Ask the butcher... e.g. what's pork tenderloin going for at Publix?"
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] outline-none placeholder:text-neutral-400"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-[13px] font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
              >
                Ask
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
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

/** Which agents worked on a reply, and (expandable) every step and handoff they took. */
function AgentActivity({ trace }: { trace: TraceEvent[] }) {
  const involved = AGENTS.filter((a) => trace.some((e) => e.agent === a.name));
  const handoffs = trace.filter((e) => e.kind === "handoff").length;
  return (
    <details className="group mb-1.5 rounded-lg border border-neutral-200 bg-white text-[12px]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-neutral-600">
        {involved.map((a, i) => (
          <span key={a.name} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-neutral-300">→</span>}
            <span className={`h-2 w-2 rounded-[3px] ${a.tone}`} />
            {a.name}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-neutral-400">
          {trace.length} steps{handoffs ? `, ${handoffs} handoffs` : ""} <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
        </span>
      </summary>
      <ol className="max-h-72 space-y-0.5 overflow-y-auto border-t border-neutral-100 px-2.5 py-2">
        {trace.map((e, i) => (
          <li key={i} className={`flex gap-2 ${e.kind === "error" ? "text-red-600" : e.kind === "handoff" ? "font-medium text-neutral-800" : "text-neutral-500"}`}>
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-[3px] ${agentTone(e.agent)}`} />
            <span className="w-24 shrink-0 text-neutral-400">{e.agent}</span>
            <span className="min-w-0">{e.summary}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-[14px] text-white">{message.content}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-900 text-[10px] font-bold text-white">HB</span>
      <div className="min-w-0 flex-1">
        {message.trace && message.trace.length > 0 && <AgentActivity trace={message.trace} />}
        <div
          className={`prose-butcher rounded-2xl rounded-tl-md border px-4 py-2.5 text-[14px] leading-relaxed ${
            message.error ? "border-red-200 bg-red-50 text-red-700" : "border-neutral-100 bg-neutral-50/70 text-neutral-800"
          }`}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
