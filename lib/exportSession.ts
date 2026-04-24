import type {
  ChatMessage,
  MeetingBrief,
  Settings,
  SuggestionBatch,
  TranscriptChunk,
} from "./types";

export interface ExportPayload {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  transcript: TranscriptChunk[];
  briefHistory: MeetingBrief[];
  batches: SuggestionBatch[];
  chat: ChatMessage[];
  settingsSnapshot: Omit<Settings, "apiKey"> & { apiKey: "[REDACTED]" };
}

export function buildExport(params: {
  sessionId: string;
  startedAt: number;
  transcript: TranscriptChunk[];
  briefHistory: MeetingBrief[];
  batches: SuggestionBatch[];
  chat: ChatMessage[];
  settings: Settings;
}): ExportPayload {
  const endedAt = Date.now();
  const { apiKey: _omit, ...rest } = params.settings;
  return {
    sessionId: params.sessionId,
    startedAt: params.startedAt,
    endedAt,
    durationMs: endedAt - params.startedAt,
    transcript: params.transcript,
    briefHistory: params.briefHistory,
    batches: params.batches,
    chat: params.chat,
    settingsSnapshot: { ...rest, apiKey: "[REDACTED]" },
  };
}

function ts(t: number): string {
  return new Date(t).toISOString();
}

export function exportToText(payload: ExportPayload): string {
  const out: string[] = [];
  out.push(`TwinMind Live Suggestions — Session Export`);
  out.push(`Session: ${payload.sessionId}`);
  out.push(`Started: ${ts(payload.startedAt)}`);
  out.push(`Ended:   ${ts(payload.endedAt)}`);
  out.push(
    `Duration: ${(payload.durationMs / 1000).toFixed(1)}s`,
  );
  out.push("");
  out.push("=== TRANSCRIPT ===");
  for (const c of payload.transcript) {
    out.push(`[${ts(c.t)}] ${c.text}`);
  }
  out.push("");
  out.push("=== MEETING BRIEF HISTORY ===");
  for (const b of payload.briefHistory) {
    out.push(`[${ts(b.t)}] Topic: ${b.topic} | Goal: ${b.goal}`);
    if (b.participants.length)
      out.push(`  Participants: ${b.participants.join(", ")}`);
    if (b.openQuestions.length) {
      out.push("  Open questions:");
      for (const q of b.openQuestions) out.push(`    - ${q}`);
    }
    if (b.keyFacts.length) {
      out.push("  Key facts:");
      for (const f of b.keyFacts) out.push(`    - ${f}`);
    }
  }
  out.push("");
  out.push("=== SUGGESTION BATCHES (oldest first) ===");
  const batchesOldestFirst = [...payload.batches].sort((a, b) => a.t - b.t);
  for (const b of batchesOldestFirst) {
    out.push(
      `[${ts(b.t)}] Batch ${b.id}${b.latencyMs ? ` (${b.latencyMs}ms)` : ""}`,
    );
    for (const c of b.cards) {
      out.push(`  [${c.type}] ${c.preview}`);
      out.push(`    seed: ${c.expandedSeed}`);
      if (c.used) out.push(`    (clicked)`);
    }
  }
  out.push("");
  out.push("=== CHAT ===");
  for (const m of payload.chat) {
    out.push(`[${ts(m.t)}] ${m.role.toUpperCase()}: ${m.content}`);
  }
  out.push("");
  out.push("=== SETTINGS SNAPSHOT ===");
  out.push(JSON.stringify(payload.settingsSnapshot, null, 2));
  return out.join("\n");
}
