import "server-only";
import { chatCompletion, type ChatMessage } from "../openrouter";
import { HAPPY_BUTCHER_SYSTEM } from "../persona";
import { saveAgentRun } from "../queries";
import { runTool, TOOL_DEFINITIONS } from "../tools";
import { Trace, type TraceEvent } from "./runtime";

// The Happy Butcher in chat: the orchestrator the customer talks to. He decides which specialist
// to involve (through his tools), then answers in his own voice.

const MAX_TOOL_ROUNDS = 8;

export async function runButcherChat(
  history: { role: "user" | "assistant"; content: string }[],
): Promise<{ reply: string; trace: TraceEvent[]; runId: number | null }> {
  const trace = new Trace();
  const messages: ChatMessage[] = [{ role: "system", content: HAPPY_BUTCHER_SYSTEM }, ...history];
  // Text written alongside tool calls (e.g. answering the off-topic half of a question) is part of the reply.
  const spoken: string[] = [];
  let reply: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS && reply === null; round++) {
    const res = await chatCompletion({ messages, tools: TOOL_DEFINITIONS, maxTokens: 2000 });
    if (res.content?.trim()) spoken.push(res.content.trim());
    if (res.toolCalls.length === 0) {
      reply = spoken.join("\n\n") || "Well, I'll be, I lost my train of thought. Ask me that again?";
      break;
    }

    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    const results = await Promise.all(
      res.toolCalls.map(async (call) => {
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          trace.add("Happy Butcher", "tool", `${call.function.name}${args.item ? ` "${args.item}"` : args.action ? ` (${args.action})` : ""}`);
          return { id: call.id, content: JSON.stringify(await runTool(call.function.name, args, trace)) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          trace.add("Happy Butcher", "error", `${call.function.name}: ${message}`);
          return { id: call.id, content: JSON.stringify({ error: message }) };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }

  reply ??= [...spoken, "Whew, that's a lot of chopping for one question. Let's try it again, a bit simpler?"].join("\n\n");
  const lastQuestion = history.findLast((m) => m.role === "user")?.content ?? "";
  const runId = trace.events.length ? await saveAgentRun("chat", lastQuestion.slice(0, 200), trace.events).catch(() => null) : null;
  return { reply, trace: trace.events, runId };
}
