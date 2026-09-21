import "server-only";
import { requireEnv } from "./env";

// Chat completions through OpenRouter (OpenAI-compatible format, which OpenRouter translates to
// Claude's native tool use).

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export async function chatCompletion(input: {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  maxTokens: number;
  temperature?: number;
  model?: string;
  timeoutMs?: number;
}): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
      "X-Title": "Happy Butcher",
    },
    body: JSON.stringify({
      model: input.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
      messages: input.messages,
      ...(input.tools?.length ? { tools: input.tools, tool_choice: input.toolChoice ?? "auto" } : {}),
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error(`OpenRouter returned no message: ${JSON.stringify(data).slice(0, 500)}`);
  return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
}

/** Pull the JSON object out of a model reply, tolerating code fences or stray prose. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Model reply contained no JSON object");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
