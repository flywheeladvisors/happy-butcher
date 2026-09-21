import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "@/lib/basicAuth";

// Password-protects every page and API route. /api/weekly-check is excluded because it
// authenticates with CRON_SECRET instead.
export function proxy(request: NextRequest) {
  const access = checkBasicAuth(request.headers.get("authorization"));
  if (access === "ok") return NextResponse.next();
  if (access === "not_configured") {
    return new NextResponse("APP_PASSWORD is not configured for this deployment.", { status: 503 });
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Happy Butcher", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!api/weekly-check|_next/static|_next/image|favicon.ico).*)"],
};
