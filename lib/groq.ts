const GROQ_BASE = "https://api.groq.com/openai/v1";

export class GroqError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "GroqError";
  }
}

function parseRetryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 30_000);
  const d = Date.parse(h);
  if (Number.isFinite(d)) return Math.max(0, Math.min(d - Date.now(), 30_000));
  return null;
}

async function groqFetch(
  path: string,
  apiKey: string,
  init: RequestInit,
  timeoutMs = 30000,
  retries = 4,
): Promise<Response> {
  if (!apiKey) throw new GroqError("Missing Groq API key", 401);
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Chain caller abort to the timeout controller so both fire.
    const userSignal = init.signal;
    const onUserAbort = () => ctrl.abort();
    if (userSignal) {
      if (userSignal.aborted) ctrl.abort();
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }
    try {
      const res = await fetch(`${GROQ_BASE}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!res.ok) {
        const status = res.status;
        let detail = "";
        try {
          detail = await res.text();
        } catch {}
        // Retry on 429 / 5xx with backoff, honoring Retry-After.
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (retryable && attempt < retries && !userSignal?.aborted) {
          const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
          const backoff =
            retryAfter ?? Math.min(800 * 2 ** attempt, 8000) + Math.random() * 250;
          attempt += 1;
          clearTimeout(timer);
          userSignal?.removeEventListener("abort", onUserAbort);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new GroqError(
          `Groq ${status} ${res.statusText}: ${detail.slice(0, 300)}`,
          status,
        );
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e instanceof GroqError) throw e;
      if (userSignal?.aborted) throw e;
      // Network error: retry with backoff.
      if (attempt < retries) {
        const backoff = Math.min(600 * 2 ** attempt, 4000) + Math.random() * 200;
        attempt += 1;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onUserAbort);
    }
  }
  throw (lastErr as Error) ?? new GroqError("Groq request failed", 500);
}

export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function groqChatJSON<T>(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const body = {
    model: params.model,
    response_format: { type: "json_object" },
    temperature: params.temperature ?? 0.4,
    max_tokens: params.maxTokens ?? 900,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
  };
  const res = await groqFetch(
    "/chat/completions",
    params.apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    },
    params.timeoutMs ?? 15000,
  );
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new GroqError(
      `Failed to parse JSON from model output: ${content.slice(0, 200)}`,
      500,
    );
  }
}

export async function groqChatStream(params: {
  apiKey: string;
  model: string;
  messages: GroqChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  const body = {
    model: params.model,
    stream: true,
    temperature: params.temperature ?? 0.5,
    max_tokens: params.maxTokens ?? 900,
    messages: params.messages,
  };
  return groqFetch(
    "/chat/completions",
    params.apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    },
    60000,
  );
}

export interface WhisperSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

export async function groqTranscribe(params: {
  apiKey: string;
  model: string;
  audio: Blob;
  filename?: string;
  prompt?: string;
  language?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  duration?: number;
  segments?: WhisperSegment[];
}> {
  const form = new FormData();
  form.append("file", params.audio, params.filename ?? "chunk.webm");
  form.append("model", params.model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (params.prompt) form.append("prompt", params.prompt);
  if (params.language) form.append("language", params.language);
  const res = await groqFetch(
    "/audio/transcriptions",
    params.apiKey,
    {
      method: "POST",
      body: form,
      signal: params.signal,
    },
    params.timeoutMs ?? 45000,
  );
  const json = (await res.json()) as {
    text?: string;
    duration?: number;
    segments?: WhisperSegment[];
  };
  return {
    text: json.text ?? "",
    duration: json.duration,
    segments: json.segments,
  };
}
