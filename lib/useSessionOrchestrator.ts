"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRecorder } from "./useRecorder";
import {
  assignIdsToCards,
  downvotedPreviews,
  recentPreviews,
  transcriptTail,
  useSessionStore,
  whisperContinuation,
} from "./sessionStore";
import {
  callBrief,
  callSuggestions,
  callTranscribe,
} from "./clientApi";
import { DEMO_TRANSCRIPT } from "./demoTranscript";
import type { TranscriptChunk } from "./types";

// Upper bound on how long a single suggestion round is allowed to run on
// the client before we abort the fetch and surface a retry. The server's
// worst case (initial call + repair + dedupe, each up to 15s, plus
// exponential backoff on 429s) can exceed this, so this is the client's
// safety valve that keeps the UI responsive when Groq is slow/rate-limited.
const SUGGESTION_HARD_TIMEOUT_MS = 60_000;
// How long a round can run before a manual ↻ click treats it as stuck and
// aborts instead of silently coalescing into a stale-follow-up.
const SUGGESTION_STUCK_THRESHOLD_MS = 20_000;
// Watchdog: if the in-flight flag is somehow still set this long after a
// round started (e.g. abort failed, a finally was skipped by a throw in
// a pre-try block), clear it so the UI recovers on its own.
const SUGGESTION_WATCHDOG_MS = 90_000;

export function useSessionOrchestrator() {
  const state = useSessionStore();
  const demoTimerRef = useRef<number | null>(null);
  const demoIndexRef = useRef<number>(0);
  const chunkCountRef = useRef<number>(0);

  // Suggestion pipeline coordination.
  // We deliberately do NOT abort an in-flight suggestion request when a new
  // transcript chunk arrives: on Groq's free tier a single suggestion round
  // can take 15–40s, and chunks arrive every ~20s. Aborting on every chunk
  // means the batch never lands and the UI is stuck on "refreshing…" forever.
  // Instead we: (a) skip firing a new round if one is already in flight, and
  // (b) if new content arrived during the round, mark it stale and fire one
  // more round as soon as the current one completes.
  const suggestionInFlightRef = useRef<boolean>(false);
  const suggestionStaleRef = useRef<boolean>(false);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  // Wall-clock timestamp when the current in-flight round started. Used by
  // the manual-refresh escape hatch and the watchdog to detect rounds that
  // have overrun and should be force-cancelled.
  const suggestionStartedAtRef = useRef<number>(0);
  const briefInFlightRef = useRef<boolean>(false);
  const briefAbortRef = useRef<AbortController | null>(null);
  /** After ↻ while recording, run suggestions only after the flushed slice is transcribed (or skipped). */
  const pendingManualRefreshRef = useRef(false);

  const shouldRunBrief = useCallback((): boolean => {
    const s = useSessionStore.getState();
    chunkCountRef.current += 1;
    if (s.transcript.length === 0) return false;
    return (
      chunkCountRef.current === 1 ||
      chunkCountRef.current % s.settings.briefEveryNChunks === 0
    );
  }, []);

  const runBrief = useCallback(async (chunk: TranscriptChunk) => {
    if (briefInFlightRef.current) return;
    const s = useSessionStore.getState();
    briefInFlightRef.current = true;
    const ctrl = new AbortController();
    briefAbortRef.current = ctrl;
    const window = transcriptTail(s.transcript, s.settings.briefContextChars);
    try {
      const resp = await callBrief({
        apiKey: s.settings.apiKey,
        settings: {
          suggestionModel: s.settings.suggestionModel,
          briefSystemPrompt: s.settings.briefSystemPrompt,
          briefContextChars: s.settings.briefContextChars,
        },
        previousBrief: s.brief,
        transcriptWindow: window,
        signal: ctrl.signal,
      });
      useSessionStore.getState().setBrief({
        t: Date.now(),
        topic: resp.brief.topic,
        goal: resp.brief.goal,
        participants: resp.brief.participants,
        openQuestions: resp.brief.openQuestions,
        keyFacts: resp.brief.keyFacts,
        updatedFromChunkIds: [chunk.id],
      });
    } catch {
      // swallow brief failures — they're best-effort background enrichment
    } finally {
      briefInFlightRef.current = false;
      if (briefAbortRef.current === ctrl) briefAbortRef.current = null;
    }
  }, []);

  const runSuggestions = useCallback(async (): Promise<void> => {
    const s = useSessionStore.getState();
    if (!s.settings.apiKey) {
      s.setError("Paste your Groq API key in Settings to generate suggestions.");
      return;
    }
    if (suggestionInFlightRef.current) {
      // Coalesce: one follow-up round will fire when the current one finishes.
      suggestionStaleRef.current = true;
      return;
    }
    suggestionInFlightRef.current = true;
    suggestionStartedAtRef.current = Date.now();
    const ctrl = new AbortController();
    suggestionAbortRef.current = ctrl;
    // Hard client-side timeout. Without this, if the server hangs (e.g. a
    // 429 backoff storm or a long Groq retry chain), the fetch awaits
    // forever, the in-flight flag never clears, and auto-refresh locks up
    // for the rest of the session. Aborting triggers the catch/finally and
    // lets the next chunk's auto-refresh (or a manual ↻) run cleanly.
    let timedOut = false;
    const hardTimeout = setTimeout(() => {
      timedOut = true;
      try {
        ctrl.abort();
      } catch {
        // abort() can synchronously throw in some polyfills; fine to ignore.
      }
    }, SUGGESTION_HARD_TIMEOUT_MS);
    try {
      useSessionStore.getState().setGeneratingSuggestions(true);
      useSessionStore.getState().setError(null);
      const startedAt = performance.now();
      const snap = useSessionStore.getState();
      const tail = transcriptTail(
        snap.transcript,
        snap.settings.suggestionContextChars,
      );
      const resp = await callSuggestions({
        apiKey: snap.settings.apiKey,
        settings: {
          suggestionModel: snap.settings.suggestionModel,
          plannerSystemPrompt: snap.settings.plannerSystemPrompt,
          generatorSystemPrompt: snap.settings.generatorSystemPrompt,
          suggestionContextChars: snap.settings.suggestionContextChars,
          meetingType: snap.settings.meetingType,
        },
        transcriptTail: tail,
        brief: snap.brief,
        recentPreviews: recentPreviews(snap.batches, 6),
        downvotedPreviews: downvotedPreviews(snap.batches, 8),
        signal: ctrl.signal,
      });
      const ms = Math.round(performance.now() - startedAt);
      const store = useSessionStore.getState();
      store.addBatch({
        t: Date.now(),
        cards: assignIdsToCards(resp.batch.cards),
        plannerNote: resp.batch.plannerNote,
        latencyMs: resp.batch.latencyMs,
      });
      store.setLastSuggestionLatency(ms);
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        if (timedOut) {
          useSessionStore
            .getState()
            .setError(
              "Suggestions timed out after 60s — Groq was unresponsive. Click ↻ to retry.",
            );
        }
        // Otherwise this was a user-initiated abort (manual refresh taking
        // over, or unmount); stay quiet.
      } else {
        useSessionStore.getState().setError(err.message);
      }
    } finally {
      clearTimeout(hardTimeout);
      suggestionInFlightRef.current = false;
      suggestionStartedAtRef.current = 0;
      if (suggestionAbortRef.current === ctrl) suggestionAbortRef.current = null;
      useSessionStore.getState().setGeneratingSuggestions(false);
      if (suggestionStaleRef.current) {
        suggestionStaleRef.current = false;
        // Schedule the follow-up on a microtask so the UI paints the just-added
        // batch before we start the next round (keeps "NEW" tag visible).
        Promise.resolve().then(() => void runSuggestions());
      }
    }
  }, []);

  const handleChunk = useCallback(
    async (audio: { blob: Blob; durationMs: number }) => {
      const s = useSessionStore.getState();
      if (!s.settings.apiKey) {
        s.setError(
          "Paste your Groq API key in Settings to transcribe audio.",
        );
        if (pendingManualRefreshRef.current) {
          pendingManualRefreshRef.current = false;
          void runSuggestions();
        }
        return;
      }
      s.setTranscribing(true);
      s.setError(null);
      let addedTranscript = false;
      try {
        const result = await callTranscribe({
          apiKey: s.settings.apiKey,
          model: s.settings.transcriptionModel,
          blob: audio.blob,
          continuationPrompt: whisperContinuation(s.transcript),
        });
        if (result.text) {
          addedTranscript = true;
          const chunk = useSessionStore.getState().addTranscriptChunk({
            t: Date.now(),
            durationMs: result.durationMs || audio.durationMs,
            text: result.text,
            source: "mic",
          });
          const wantBrief = shouldRunBrief();
          if (wantBrief) void runBrief(chunk);
        }
      } catch (e) {
        useSessionStore.getState().setError((e as Error).message);
      } finally {
        useSessionStore.getState().setTranscribing(false);
        const st = useSessionStore.getState();
        if (pendingManualRefreshRef.current) {
          pendingManualRefreshRef.current = false;
          void runSuggestions();
        } else if (addedTranscript && st.settings.autoRefresh) {
          void runSuggestions();
        }
      }
    },
    [runBrief, runSuggestions, shouldRunBrief],
  );

  const onChunkSkipped = useCallback(() => {
    if (pendingManualRefreshRef.current) {
      pendingManualRefreshRef.current = false;
      void runSuggestions();
    }
  }, [runSuggestions]);

  const recorder = useRecorder({
    timesliceMs: state.settings.chunkSeconds * 1000,
    onChunk: handleChunk,
    onChunkSkipped,
    onError: (err) => {
      useSessionStore.getState().setError(err.message || "Microphone error");
    },
  });

  const stopDemoMode = useCallback(() => {
    if (demoTimerRef.current) {
      window.clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  }, []);

  const startDemoMode = useCallback(() => {
    if (demoTimerRef.current) return;
    demoIndexRef.current = 0;
    const tick = () => {
      const s = useSessionStore.getState();
      if (!s.settings.demoMode) {
        stopDemoMode();
        return;
      }
      const demo = DEMO_TRANSCRIPT[demoIndexRef.current % DEMO_TRANSCRIPT.length];
      demoIndexRef.current += 1;
      const chunk = useSessionStore.getState().addTranscriptChunk({
        t: Date.now(),
        durationMs: demo.durationMs,
        text: demo.text,
        source: "demo",
      });
      const wantBrief = shouldRunBrief();
      if (useSessionStore.getState().settings.autoRefresh) {
        void runSuggestions();
      }
      if (wantBrief) void runBrief(chunk);
    };
    tick();
    demoTimerRef.current = window.setInterval(tick, 8000);
  }, [runBrief, runSuggestions, shouldRunBrief, stopDemoMode]);

  useEffect(() => {
    return () => {
      stopDemoMode();
      suggestionAbortRef.current?.abort();
      briefAbortRef.current?.abort();
    };
  }, [stopDemoMode]);

  const startRecording = useCallback(async () => {
    const s = useSessionStore.getState();
    if (!s.settings.apiKey) {
      s.setError("Paste your Groq API key in Settings to start recording.");
      s.openSettings();
      return;
    }
    if (s.settings.demoMode) {
      s.setError("Demo mode is on. Turn it off in Settings before recording.");
      return;
    }
    await recorder.start();
    useSessionStore.getState().setRecording(true);
  }, [recorder]);

  const stopRecording = useCallback(() => {
    recorder.stop();
    useSessionStore.getState().setRecording(false);
  }, [recorder]);

  const manualRefresh = useCallback(async () => {
    const s = useSessionStore.getState();
    let willFlush = false;
    if (s.isRecording && !s.settings.demoMode) {
      willFlush = true;
      pendingManualRefreshRef.current = true;
      recorder.flushNow();
    }
    if (s.settings.demoMode && !demoTimerRef.current) {
      startDemoMode();
      return;
    }
    if (suggestionInFlightRef.current) {
      // Escape hatch: if the current round has run longer than the "stuck"
      // threshold, the user clicking ↻ means "this is frozen, try again".
      // Abort the current fetch and request a fresh round — the aborted
      // round's finally-block will schedule the follow-up via staleRef so
      // we don't race two runSuggestions() in parallel.
      const runFor = Date.now() - suggestionStartedAtRef.current;
      if (runFor > SUGGESTION_STUCK_THRESHOLD_MS) {
        suggestionStaleRef.current = true;
        try {
          suggestionAbortRef.current?.abort();
        } catch {
          // ignore
        }
        return;
      }
      // Otherwise just coalesce — a follow-up round is already scheduled.
      suggestionStaleRef.current = true;
      return;
    }
    if (willFlush) {
      // Suggestions run after the flushed slice is transcribed (or skipped) in
      // handleChunk / onChunkSkipped.
      return;
    }
    await runSuggestions();
  }, [recorder, runSuggestions, startDemoMode]);

  // Watchdog: paranoia check in case the normal abort/finally path fails.
  // If the in-flight flag has been set longer than SUGGESTION_WATCHDOG_MS,
  // force-clear it so the user isn't permanently stuck on "refreshing…".
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!suggestionInFlightRef.current) return;
      if (suggestionStartedAtRef.current === 0) return;
      const runFor = Date.now() - suggestionStartedAtRef.current;
      if (runFor < SUGGESTION_WATCHDOG_MS) return;
      try {
        suggestionAbortRef.current?.abort();
      } catch {
        // ignore
      }
      suggestionInFlightRef.current = false;
      suggestionStartedAtRef.current = 0;
      suggestionAbortRef.current = null;
      useSessionStore.getState().setGeneratingSuggestions(false);
      useSessionStore
        .getState()
        .setError(
          "Suggestion refresh was stuck for >90s and was cleared. Click ↻ to try again.",
        );
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  return {
    startRecording,
    stopRecording,
    manualRefresh,
    runSuggestions,
    startDemoMode,
    stopDemoMode,
    recorderSupported: recorder.supported,
    micLevel: recorder.level,
  };
}
