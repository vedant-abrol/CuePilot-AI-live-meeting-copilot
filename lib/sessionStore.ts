"use client";

import { create } from "zustand";
import type {
  CardRating,
  ChatMessage,
  MeetingBrief,
  Settings,
  SuggestionBatch,
  SuggestionCard,
  TranscriptChunk,
} from "./types";
import { DEFAULT_SETTINGS } from "./defaultSettings";

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

const SETTINGS_KEY = "twinmind.settings.v2";
const LEGACY_SETTINGS_KEYS = ["twinmind.settings.v1"];

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
    // Migrate from older versions: keep only the API key and drop the rest
    // so the user gets fresh, better-tuned defaults.
    for (const key of LEGACY_SETTINGS_KEYS) {
      const legacy = window.localStorage.getItem(key);
      if (!legacy) continue;
      try {
        const old = JSON.parse(legacy) as Partial<Settings>;
        const migrated: Settings = {
          ...DEFAULT_SETTINGS,
          apiKey: old.apiKey ?? DEFAULT_SETTINGS.apiKey,
        };
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated));
        window.localStorage.removeItem(key);
        return migrated;
      } catch {}
    }
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(s: Settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

export interface SessionState {
  sessionId: string;
  startedAt: number;
  transcript: TranscriptChunk[];
  batches: SuggestionBatch[];
  chat: ChatMessage[];
  brief: MeetingBrief | null;
  briefHistory: MeetingBrief[];
  isRecording: boolean;
  recordingStartedAt: number | null;
  // Total ms the mic has been actively recording across all start/stop
  // cycles in this session. Pausing preserves this; only `resetSession`
  // clears it. Live elapsed is `accumulatedRecordingMs + (now -
  // recordingStartedAt)` when `isRecording`.
  accumulatedRecordingMs: number;
  isTranscribing: boolean;
  isGeneratingSuggestions: boolean;
  error: string | null;
  settings: Settings;
  settingsHydrated: boolean;
  settingsOpen: boolean;
  lastSuggestionLatencyMs: number | null;
  lastFirstTokenMs: number | null;

  addTranscriptChunk: (chunk: Omit<TranscriptChunk, "id">) => TranscriptChunk;
  addBatch: (batch: Omit<SuggestionBatch, "id">) => SuggestionBatch;
  markCardUsed: (batchId: string, cardId: string) => void;
  rateCard: (batchId: string, cardId: string, rating: CardRating | null) => void;
  togglePinCard: (batchId: string, cardId: string) => void;
  addChatMessage: (msg: Omit<ChatMessage, "id">) => ChatMessage;
  updateChatMessage: (id: string, patch: Partial<ChatMessage>) => void;
  appendChatContent: (id: string, chunk: string) => void;
  setBrief: (brief: MeetingBrief) => void;
  setRecording: (v: boolean) => void;
  setTranscribing: (v: boolean) => void;
  setGeneratingSuggestions: (v: boolean) => void;
  setError: (msg: string | null) => void;
  hydrateSettings: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setLastSuggestionLatency: (ms: number) => void;
  setLastFirstTokenMs: (ms: number) => void;
  resetSession: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: newId("sess"),
  startedAt: Date.now(),
  transcript: [],
  batches: [],
  chat: [],
  brief: null,
  briefHistory: [],
  isRecording: false,
  recordingStartedAt: null,
  accumulatedRecordingMs: 0,
  isTranscribing: false,
  isGeneratingSuggestions: false,
  error: null,
  settings: DEFAULT_SETTINGS,
  settingsHydrated: false,
  settingsOpen: false,
  lastSuggestionLatencyMs: null,
  lastFirstTokenMs: null,

  addTranscriptChunk: (chunk) => {
    const c: TranscriptChunk = { id: newId("chk"), ...chunk };
    set((s) => ({ transcript: [...s.transcript, c] }));
    return c;
  },
  addBatch: (batch) => {
    const b: SuggestionBatch = { id: newId("batch"), ...batch };
    set((s) => ({ batches: [b, ...s.batches] }));
    return b;
  },
  markCardUsed: (batchId, cardId) =>
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id !== batchId
          ? b
          : {
              ...b,
              cards: b.cards.map((c) =>
                c.id === cardId ? { ...c, used: true } : c,
              ),
            },
      ),
    })),
  rateCard: (batchId, cardId, rating) =>
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id !== batchId
          ? b
          : {
              ...b,
              cards: b.cards.map((c) =>
                c.id === cardId
                  ? { ...c, rating: rating ?? undefined }
                  : c,
              ),
            },
      ),
    })),
  togglePinCard: (batchId, cardId) =>
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id !== batchId
          ? b
          : {
              ...b,
              cards: b.cards.map((c) =>
                c.id === cardId ? { ...c, pinned: !c.pinned } : c,
              ),
            },
      ),
    })),
  addChatMessage: (msg) => {
    const m: ChatMessage = { id: newId("msg"), ...msg };
    set((s) => ({ chat: [...s.chat, m] }));
    return m;
  },
  updateChatMessage: (id, patch) =>
    set((s) => ({
      chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  appendChatContent: (id, chunk) =>
    set((s) => ({
      chat: s.chat.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m,
      ),
    })),
  setBrief: (brief) =>
    set((s) => ({
      brief,
      // Cap briefHistory so long sessions don't grow unbounded. We only
      // display the latest brief; we keep a small tail for debug/export.
      briefHistory: [...s.briefHistory.slice(-19), brief],
    })),
  setRecording: (v) =>
    set((s) => {
      // Stopping: roll the live elapsed into the accumulator so resume can
      // continue counting from where we left off instead of restarting at 0.
      if (!v && s.isRecording && s.recordingStartedAt != null) {
        const delta = Math.max(0, Date.now() - s.recordingStartedAt);
        return {
          isRecording: false,
          recordingStartedAt: null,
          accumulatedRecordingMs: s.accumulatedRecordingMs + delta,
        };
      }
      // Starting (or no-op start while already recording).
      return {
        isRecording: v,
        recordingStartedAt: v ? (s.recordingStartedAt ?? Date.now()) : null,
      };
    }),
  setTranscribing: (v) => set({ isTranscribing: v }),
  setGeneratingSuggestions: (v) => set({ isGeneratingSuggestions: v }),
  setError: (msg) => set({ error: msg }),
  hydrateSettings: () => {
    if (get().settingsHydrated) return;
    const next = loadSettings();
    set({ settings: next, settingsHydrated: true });
  },
  updateSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      persistSettings(next);
      return { settings: next };
    }),
  resetSettings: () => {
    persistSettings(DEFAULT_SETTINGS);
    set({ settings: { ...DEFAULT_SETTINGS } });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setLastSuggestionLatency: (ms) => set({ lastSuggestionLatencyMs: ms }),
  setLastFirstTokenMs: (ms) => set({ lastFirstTokenMs: ms }),
  resetSession: () =>
    set((s) => ({
      sessionId: newId("sess"),
      startedAt: Date.now(),
      transcript: [],
      batches: [],
      chat: [],
      brief: null,
      briefHistory: [],
      isRecording: false,
      recordingStartedAt: null,
      accumulatedRecordingMs: 0,
      isTranscribing: false,
      isGeneratingSuggestions: false,
      error: null,
      lastSuggestionLatencyMs: null,
      lastFirstTokenMs: null,
      settings: s.settings,
      settingsOpen: false,
    })),
}));

export function transcriptTail(
  chunks: TranscriptChunk[],
  chars: number,
): string {
  if (chunks.length === 0) return "";
  const joined = chunks
    .map((c) => {
      const ts = new Date(c.t).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `[${ts}] ${c.text.trim()}`;
    })
    .join("\n");
  if (joined.length <= chars) return joined;
  return "…\n" + joined.slice(joined.length - chars);
}

export function recentPreviews(
  batches: SuggestionBatch[],
  count: number = 6,
): string[] {
  const out: string[] = [];
  for (const b of batches) {
    for (const c of b.cards) {
      out.push(c.preview);
      if (out.length >= count) return out;
    }
  }
  return out;
}

// Returns previews of cards the user has explicitly thumbs-down'd. Feeds the
// "avoid these" list on the next suggestion round, so the feedback loop is
// visible in the next batch. Caps at `count` newest-first so we don't grow
// the prompt unbounded on a long session.
export function downvotedPreviews(
  batches: SuggestionBatch[],
  count: number = 8,
): string[] {
  const out: string[] = [];
  for (const b of batches) {
    for (const c of b.cards) {
      if (c.rating === "down") out.push(c.preview);
      if (out.length >= count) return out;
    }
  }
  return out;
}

// Returns every pinned card across all batches (newest first). Rendered as
// a sticky band above the live-suggestions feed so a user can freeze useful
// cards (usually fact-checks) they want to come back to.
export interface PinnedCardRef {
  batchId: string;
  card: SuggestionCard;
}
export function pinnedCardRefs(batches: SuggestionBatch[]): PinnedCardRef[] {
  const out: PinnedCardRef[] = [];
  for (const b of batches) {
    for (const c of b.cards) {
      if (c.pinned) out.push({ batchId: b.id, card: c });
    }
  }
  return out;
}

export function whisperContinuation(chunks: TranscriptChunk[]): string {
  if (chunks.length === 0) return "";
  const last = chunks[chunks.length - 1];
  return last.text.slice(-200);
}

export function assignIdsToCards(
  cards: Array<Omit<SuggestionCard, "id">>,
): SuggestionCard[] {
  return cards.map((c) => ({ ...c, id: newId("card") }));
}
