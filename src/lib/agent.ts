import "server-only";
import { chatCompletion, type ChatMessage } from "./openrouter";
import { HAPPY_BUTCHER_SYSTEM } from "./persona";
import { runTool, TOOL_DEFINITIONS } from "./tools";

export interface ToolEvent {
  name: string;
  args: unknown;
  ok: boolean;
  result: unknown;
}

const MAX_TOOL_ROUNDS = 8;

/** Runs the Happy Butcher over a conversation, executing tool calls until he answers in text. */
export async function runAgent(history: { role: "user" | "assistant"; content: string }[]) {
  const messages: ChatMessage[] = [{ role: "system", content: HAPPY_BUTCHER_SYSTEM }, ...history];
  const toolEvents: ToolEvent[] = [];
  // Text the model writes alongside tool calls (e.g. answering the off-topic half of a question)
  // is part of the reply too.
  const spoken: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await chatCompletion({ messages, tools: TOOL_DEFINITIONS, maxTokens: 2000 });
    if (reply.content?.trim()) spoken.push(reply.content.trim());
    if (reply.toolCalls.length === 0) {
      return { reply: spoken.join("\n\n") || "Well, I'll be, I lost my train of thought. Ask me that again?", toolEvents };
    }

    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
    const results = await Promise.all(
      reply.toolCalls.map(async (call) => {
        let args: unknown = call.function.arguments;
        try {
          args = JSON.parse(call.function.arguments || "{}");
          const result = await runTool(call.function.name, args);
          toolEvents.push({ name: call.function.name, args, ok: true, result });
          return { id: call.id, content: JSON.stringify(result) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolEvents.push({ name: call.function.name, args, ok: false, result: message });
          return { id: call.id, content: JSON.stringify({ error: message }) };
        }
      }),
    );
    for (const { id, content } of results) messages.push({ role: "tool", tool_call_id: id, content });
  }
  spoken.push("Whew, that's a lot of chopping for one question. Let's try it again, a bit simpler?");
  return { reply: spoken.join("\n\n"), toolEvents };
}
