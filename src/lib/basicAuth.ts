import { timingSafeEqual } from "node:crypto";

// Single shared password for the whole app (HTTP Basic auth; any username).
// Unset APP_PASSWORD leaves local dev open but blocks everything in production (fail closed).

export type AccessCheck = "ok" | "unauthorized" | "not_configured";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkBasicAuth(authorizationHeader: string | null): AccessCheck {
  const password = process.env.APP_PASSWORD;
  if (!password) return process.env.NODE_ENV === "production" ? "not_configured" : "ok";
  if (!authorizationHeader?.startsWith("Basic ")) return "unauthorized";
  let decoded = "";
  try {
    decoded = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
  } catch {
    return "unauthorized";
  }
  const provided = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(provided, password) ? "ok" : "unauthorized";
}
