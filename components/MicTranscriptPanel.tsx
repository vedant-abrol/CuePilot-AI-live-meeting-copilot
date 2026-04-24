"use client";

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/lib/sessionStore";
import type { useSessionOrchestrator } from "@/lib/useSessionOrchestrator";

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

// VU-style meter. Reads the smoothed RMS from the recorder hook at ~30 Hz via
// requestAnimationFrame and paints a 24-segment bar. We clamp on a square-
// root curve so quiet speech (RMS ~0.02) visibly lights up the meter while
// loud audio (RMS ~0.3) doesn't peg it. Also flags when the level falls
// below the silence gate threshold so the user understands why their chunk
// might be skipped for transcription.
function LevelMeter({
  handle,
}: {
  handle: { read: () => number };
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  // The handle object is stable (it's a useRef.current from the recorder
  // hook), so this effect runs once per mount — no RAF churn. We read the
  // latest level every frame via the closure.
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const rms = handleRef.current.read();
      const scaled = Math.max(0, Math.min(1, Math.sqrt(rms) * 2.0));
      const pct = Math.round(scaled * 100);
      if (barRef.current) {
        barRef.current.style.width = `${pct}%`;
        if (scaled > 0.75)
          barRef.current.style.background = "rgb(244 114 182)";
        else if (scaled > 0.4)
          barRef.current.style.background = "rgb(52 211 153)";
        else if (scaled > 0.08)
          barRef.current.style.background = "rgb(124 140 255)";
        else barRef.current.style.background = "rgb(107 112 128)";
      }
      if (labelRef.current) {
        const silent = rms < 0.015;
        labelRef.current.textContent = silent
          ? "below silence gate"
          : "listening";
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="mt-1.5 flex items-center gap-2" aria-hidden="true">
      <div className="h-1.5 w-36 overflow-hidden rounded-full border border-bg-border bg-bg-raised">
        <div
          ref={barRef}
          className="h-full w-[1%] rounded-full bg-text-dim transition-[background-color] duration-100"
          style={{ transition: "width 60ms linear, background-color 120ms" }}
        />
      </div>
      <span
        ref={labelRef}
        className="text-[10px] uppercase tracking-wider text-text-dim"
      >
        listening
      </span>
    </div>
  );
}

export function MicTranscriptPanel({
  orchestrator,
}: {
  orchestrator: ReturnType<typeof useSessionOrchestrator>;
}) {
  const {
    isRecording,
    recordingStartedAt,
    accumulatedRecordingMs,
    isTranscribing,
    transcript,
    settings,
  } = useSessionStore(
    useShallow((s) => ({
      isRecording: s.isRecording,
      recordingStartedAt: s.recordingStartedAt,
      accumulatedRecordingMs: s.accumulatedRecordingMs,
      isTranscribing: s.isTranscribing,
      transcript: s.transcript,
      settings: s.settings,
    })),
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length, isTranscribing]);

  // Elapsed across all start/stop cycles in this session. Stopping rolls
  // the live delta into `accumulatedRecordingMs` (see sessionStore), so
  // resuming continues the count from where it paused instead of 0.
  const liveDeltaMs =
    isRecording && recordingStartedAt ? Math.max(0, now - recordingStartedAt) : 0;
  const totalElapsedMs = accumulatedRecordingMs + liveDeltaMs;
  // Anchor the "next refresh in Xs" countdown on the recorder's fixed slice
  // cadence (recordingStartedAt + N * chunkSeconds). Using the last
  // transcript chunk's arrival time instead would get stuck at 0 whenever
  // a slice is skipped by the silence gate (since no chunk lands to reset
  // the anchor) — which is exactly the "inaccurate / gets stuck" case the
  // user hit when sitting silent. This formulation always wraps around.
  const nextAutoSec = (() => {
    if (!isRecording || !recordingStartedAt) return null;
    const base = settings.demoMode ? 8000 : settings.chunkSeconds * 1000;
    const elapsedSinceStart = Math.max(0, now - recordingStartedAt);
    const remain = base - (elapsedSinceStart % base);
    return Math.max(1, Math.ceil(remain / 1000));
  })();

  const onToggle = async () => {
    if (settings.demoMode) {
      if (orchestrator && !isRecording) {
        orchestrator.startDemoMode();
        useSessionStore.getState().setRecording(true);
      } else {
        orchestrator.stopDemoMode();
        useSessionStore.getState().setRecording(false);
      }
      return;
    }
    if (isRecording) {
      orchestrator.stopRecording();
    } else {
      await orchestrator.startRecording();
    }
  };

  const status = settings.demoMode
    ? isRecording
      ? "DEMO"
      : "IDLE"
    : isRecording
      ? isTranscribing
        ? "RECORDING · TRANSCRIBING"
        : "RECORDING"
      : "IDLE";

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-bg-border bg-bg-panel">
      <header className="flex items-center justify-between border-b border-bg-border px-4 py-3">
        <div className="text-xs font-semibold tracking-wide text-text-muted">
          1. MIC &amp; TRANSCRIPT
        </div>
        <div className="text-[10px] font-medium text-text-dim">{status}</div>
      </header>

      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onToggle}
          className={
            "grid h-10 w-10 place-items-center rounded-full border transition " +
            (isRecording
              ? "border-rose-500/50 bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
              : "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25")
          }
          title={isRecording ? "Stop (Space)" : "Start (Space)"}
        >
          {isRecording ? (
            <span className="h-3 w-3 rounded-sm bg-rose-400" />
          ) : (
            <span className="h-3 w-3 rounded-full bg-accent" />
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col text-xs leading-tight">
          <span className="text-text">
            {isRecording
              ? settings.demoMode
                ? "Demo mode streaming."
                : "Recording."
              : totalElapsedMs > 0
                ? `Paused at ${fmtDuration(totalElapsedMs)}. Click to resume.`
                : settings.demoMode
                  ? "Demo mode on. Click to stream sample transcript."
                  : `Click mic to start. Chunks every ~${settings.chunkSeconds}s.`}
          </span>
          <span className="text-text-dim">
            {isRecording && (
              <>
                <span className="rec-dot inline-block h-1.5 w-1.5 rounded-full bg-rose-400 align-middle" />{" "}
                {fmtDuration(totalElapsedMs)}
                {nextAutoSec != null && (
                  <> · next refresh in {nextAutoSec}s</>
                )}
              </>
            )}
          </span>
          {isRecording && !settings.demoMode && orchestrator.micLevel && (
            <LevelMeter handle={orchestrator.micLevel} />
          )}
        </div>
      </div>

      <div className="mx-4 mb-3 rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] leading-snug text-text-muted">
        The transcript appends new chunks every ~{settings.chunkSeconds}s while
        recording. Stop/start with the mic button. Use Export (top-right) to
        download the full session.
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 text-sm leading-relaxed"
      >
        {transcript.length === 0 ? (
          <div className="mt-20 text-center text-xs text-text-dim">
            No transcript yet — start the mic to begin.
          </div>
        ) : (
          <ul className="space-y-3">
            {transcript.map((c) => (
              <li key={c.id} className="flex gap-3">
                <span className="mt-0.5 whitespace-nowrap text-[11px] uppercase tracking-wide text-text-dim">
                  {fmtTime(c.t)}
                </span>
                <span className="text-text">{c.text}</span>
              </li>
            ))}
            {isTranscribing && (
              <li className="flex gap-3 text-text-dim">
                <span className="mt-0.5 text-[11px] uppercase">now</span>
                <span className="shimmer rounded-md px-2 py-1 text-xs">
                  transcribing next chunk…
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
