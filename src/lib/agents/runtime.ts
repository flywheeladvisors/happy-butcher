import "server-only";
import { chatCompletion, type ChatMessage, type ToolDefinition } from "../openrouter";

// Minimal multi-agent runtime. Each agent has its own system prompt, its own tools, and its own
// loop; it finishes by calling its `submit` tool with a structured result. Agents talk to each other
// only through those results (an agent's tool may run another agent). Every step lands in a shared
// trace so the UI and the Wednesday log can show who did what.

export type AgentName = "Happy Butcher" | "Store Scout" | "Deal Hunter" | "Cut Inspector";

export interface TraceEvent {
  at: string;
  agent: AgentName;
  kind: "start" | "tool" | "handoff" | "submit" | "error";
  summary: string;
}

export class Trace {
  readonly events: TraceEvent[] = [];
  add(agent: AgentName, kind: TraceEvent["kind"], summary: string) {
    this.events.push({ at: new Date().toISOString(), agent, kind, summary: summary.slice(0, 300) });
  }
}

export interface AgentTool<Ctx> {
  name: string;
  description: string;
  parameters: object;
  run: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
  /** One-line description of a call, for the trace. */
  describe?: (args: Record<string, unknown>) => string;
}

export interface AgentSpec<Ctx, Out> {
  name: AgentName;
  system: string;
  tools: AgentTool<Ctx>[];
  submit: { name: string; description: string; parameters: object; parse: (args: unknown) => Out };
  model?: string;
  maxRounds?: number;
  maxTokens?: number;
}

const toDefinition = (t: { name: string; description: string; parameters: object }): ToolDefinition => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

/** Runs one agent to completion and returns what it submitted. */
export async function runAgent<Ctx, Out>(spec: AgentSpec<Ctx, Out>, input: string, ctx: Ctx, trace: Trace): Promise<Out> {
  const messages: ChatMessage[] = [
    { role: "system", content: spec.system },
    { role: "user", content: input },
  ];
  const definitions = [...spec.tools.map(toDefinition), toDefinition(spec.submit)];
  const maxRounds = spec.maxRounds ?? 8;
  trace.add(spec.name, "start", input.split("\n")[0]);

  // A rejected submission earns up to two extra turns to fix it, even after the round budget is spent.
  let correctionsLeft = 2;
  for (let round = 0; round < maxRounds + (2 - correctionsLeft); round++) {
    const lastRound = round >= maxRounds - 1;
    const reply = await chatCompletion({
      model: spec.model,
      temperature: 0,
      maxTokens: spec.maxTokens ?? 2500,
      messages,
      tools: definitions,
      // On the last round the agent must hand in what it has.
      toolChoice: lastRound ? { type: "function", function: { name: spec.submit.name } } : "auto",
    });

    const calls = reply.toolCalls;
    if (calls.length === 0) {
      messages.push({ role: "assistant", content: reply.content ?? "" });
      messages.push({ role: "user", content: `Finish by calling ${spec.submit.name}.` });
      continue;
    }

    const submitCall = calls.find((c) => c.function.name === spec.submit.name);
    if (submitCall) {
      try {
        const out = spec.submit.parse(JSON.parse(submitCall.function.arguments || "{}"));
        trace.add(spec.name, "submit", `submitted ${spec.submit.name}`);
        return out;
      } catch (err) {
        // Bad submission: tell the agent what was wrong and let it try again.
        const message = err instanceof Error ? err.message : String(err);
        trace.add(spec.name, "error", `invalid ${spec.submit.name}: ${message}`);
        if (correctionsLeft-- <= 0) break;
        messages.push({ role: "assistant", content: reply.content, tool_calls: [submitCall] });
        messages.push({ role: "tool", tool_call_id: submitCall.id, content: JSON.stringify({ error: `Invalid submission: ${message}` }) });
        continue;
      }
    }

    messages.push({ role: "assistant", content: reply.content, tool_calls: calls });
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = spec.tools.find((t) => t.name === call.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
          if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
          trace.add(spec.name, "tool", tool.describe ? tool.describe(args) : `${tool.name}`);
          return { id: call.id, content: JSON.stringify(await tool.run(args, ctx)) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          trace.add(spec.name, "error", `${call.function.name}: ${message}`);
          return { id: call.id, content: JSON.stringify({ error: message }) };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  throw new Error(`${spec.name} did not submit a result`);
}

// The Hunter makes many quick tool calls, so it runs on a fast model; the Inspector's judgment
// calls get the stronger one. Override per role with HUNTER_MODEL / INSPECTOR_MODEL / SCOUT_MODEL.
const DEFAULT_MODELS = { hunter: "anthropic/claude-haiku-4.5", inspector: "anthropic/claude-sonnet-5", scout: "anthropic/claude-sonnet-5" };

export const agentModel = (role: keyof typeof DEFAULT_MODELS) => process.env[`${role.toUpperCase()}_MODEL`] || DEFAULT_MODELS[role];
