import { z } from "zod";
import { runButcherChat } from "@/lib/agents/butcher";

// A reply can involve several agents (Store Scout, Deal Hunter, Cut Inspector), so allow a long run.
export const maxDuration = 300;

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(60),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  try {
    return Response.json(await runButcherChat(parsed.data.messages));
  } catch (err) {
    console.error("chat failed", err);
    return Response.json({ error: err instanceof Error ? err.message : "Chat failed" }, { status: 500 });
  }
}
