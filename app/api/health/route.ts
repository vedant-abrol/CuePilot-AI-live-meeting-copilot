import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Lightweight liveness probe for Groq. We hit /openai/v1/models, which is
// cheap (no tokens billed, no inference) but still requires a valid API
// key — so a 200 here means the user's key works AND Groq is reachable.
// Falls through to a status signal the header can surface during a live
// demo if Groq is rate-limiting or degraded.
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-groq-key") ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, status: "no_key", latencyMs: null },
      { status: 401 },
    );
  }
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res: Response;
    try {
      res = await fetch("https://api.groq.com/openai/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return NextResponse.json({ ok: true, status: "ok", latencyMs });
    }
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { ok: false, status: "bad_key", latencyMs, httpStatus: res.status },
        { status: 200 },
      );
    }
    if (res.status === 429) {
      return NextResponse.json(
        {
          ok: false,
          status: "rate_limited",
          latencyMs,
          httpStatus: res.status,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { ok: false, status: "down", latencyMs, httpStatus: res.status },
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        status: "unreachable",
        latencyMs: Date.now() - started,
        error: e instanceof Error ? e.message : "unknown",
      },
      { status: 200 },
    );
  }
}
