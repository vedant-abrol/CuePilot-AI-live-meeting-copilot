"use client";

import type {
  ChatMessage,
  MeetingBrief,
  MeetingType,
  SuggestionCard,
} from "./types";

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

export async function callTranscribe(params: {
  apiKey: string;
  model: string;
  blob: Blob;
  continuationPrompt?: string;
  signal?: AbortSignal;
}): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("file", params.blob, "chunk.webm");
  form.append("model", params.model);
  if (params.continuationPrompt) form.append("prompt", params.continuationPrompt);
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "x-groq-key": params.apiKey },
    body: form,
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcribe failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TranscribeResult;
}

export interface SuggestionsResponse {
  batch: {
    cards: Omit<SuggestionCard, "id">[];
    plannerNote: string;
    latencyMs: number;
  };
}

export async function callSuggestions(params: {
  apiKey: string;
  settings: {
    suggestionModel: string;
    plannerSystemPrompt: string;
    generatorSystemPrompt: string;
    suggestionContextChars: number;
    meetingType: MeetingType;
  };
  transcriptTail: string;
  brief: MeetingBrief | null;
  recentPreviews: string[];
  downvotedPreviews?: string[];
  signal?: AbortSignal;
}): Promise<SuggestionsResponse> {
  const res = await fetch("/api/suggestions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-groq-key": params.apiKey,
    },
    body: JSON.stringify({
      settings: params.settings,
      transcriptTail: params.transcriptTail,
      brief: params.brief,
      recentPreviews: params.recentPreviews,
      downvotedPreviews: params.downvotedPreviews ?? [],
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Suggestions failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SuggestionsResponse;
}

export interface BriefResponse {
  brief: Omit<MeetingBrief, "t" | "updatedFromChunkIds">;
}

export async function callBrief(params: {
  apiKey: string;
  settings: {
    suggestionModel: string;
    briefSystemPrompt: string;
    briefContextChars: number;
  };
  previousBrief: MeetingBrief | null;
  transcriptWindow: string;
  signal?: AbortSignal;
}): Promise<BriefResponse> {
  const res = await fetch("/api/brief", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-groq-key": params.apiKey,
    },
    body: JSON.stringify({
      settings: params.settings,
      previousBrief: params.previousBrief,
      transcriptWindow: params.transcriptWindow,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brief failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as BriefResponse;
}

export interface ChatStreamCallbacks {
  onFirstToken?: (ms: number) => void;
  onToken: (chunk: string) => void;
  onDone: (totalMs: number) => void;
  onError: (err: Error) => void;
  onAbort?: () => void;
}

function isAbortError(e: unknown): boolean {
  if (!e) return false;
  const err = e as { name?: string; code?: string; message?: string };
  if (err.name === "AbortError") return true;
  if (err.code === "ABORT_ERR") return true;
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("aborted") ||
    msg.includes("the user aborted") ||
    msg.includes("signal is aborted")
  );
}

export async function callChatStream(params: {
  apiKey: string;
  settings: {
    chatModel: string;
    chatSystemPrompt: string;
    chatContextChars: number;
  };
  brief: MeetingBrief | null;
  transcriptTail: string;
  history: ChatMessage[];
  card?: SuggestionCard | null;
  message?: string;
  signal?: AbortSignal;
  cb: ChatStreamCallbacks;
}): Promise<void> {
  const started = performance.now();
  if (params.signal?.aborted) {
    params.cb.onAbort?.();
    return;
  }
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-groq-key": params.apiKey,
      },
      body: JSON.stringify({
        settings: params.settings,
        brief: params.brief,
        transcriptTail: params.transcriptTail,
        history: params.history.map((m) => ({ role: m.role, content: m.content })),
        card: params.card ?? null,
        message: params.message ?? null,
      }),
      signal: params.signal,
    });
  } catch (e) {
    // Treat user-initiated aborts as expected — they happen every time the
    // user sends a follow-up message or clicks another suggestion while a
    // previous stream is still running. Surfacing them as errors pops an
    // Unhandled Runtime Error overlay in dev and pollutes the chat bubble.
    if (isAbortError(e) || params.signal?.aborted) {
      params.cb.onAbort?.();
      return;
    }
    params.cb.onError(e as Error);
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    params.cb.onError(
      new Error(`Chat failed: ${res.status} ${text.slice(0, 200)}`),
    );
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let gotFirstToken = false;
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload) as { delta?: string; error?: string };
          if (obj.error) {
            params.cb.onError(new Error(obj.error));
            return;
          }
          if (obj.delta) {
            if (!gotFirstToken) {
              gotFirstToken = true;
              params.cb.onFirstToken?.(performance.now() - started);
            }
            params.cb.onToken(obj.delta);
          }
        } catch {}
      }
    }
    params.cb.onDone(performance.now() - started);
  } catch (e) {
    if (isAbortError(e) || params.signal?.aborted) {
      params.cb.onAbort?.();
      return;
    }
    params.cb.onError(e as Error);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
