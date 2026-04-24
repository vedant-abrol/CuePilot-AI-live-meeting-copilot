"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface RecorderChunk {
  blob: Blob;
  durationMs: number;
  mime: string;
}

export interface UseRecorderOpts {
  timesliceMs: number;
  onChunk: (chunk: RecorderChunk) => void | Promise<void>;
  onError?: (err: Error) => void;
  // RMS level at which we consider the chunk "speech". Tuned empirically for
  // a getUserMedia stream with browser's built-in noiseSuppression + AGC on:
  // room silence sits at ~0.002–0.006, a desk fan is ~0.005–0.012, spoken
  // speech trivially exceeds 0.02 even at low volume. 0.015 is a safe floor
  // that rejects silence/fan/typing but never swallows actual voice.
  silenceRmsThreshold?: number;
}

export interface LevelMeterHandle {
  // Returns the current instantaneous RMS of the mic stream (0..~1).
  // Zero when not recording or the audio graph hasn't initialised. Sampling
  // is lock-free; safe to call at ~30 Hz from a UI animation loop.
  read: () => number;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export function useRecorder(opts: UseRecorderOpts) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chunkStartRef = useRef<number>(0);
  const sliceTimerRef = useRef<number | null>(null);
  const mimeRef = useRef<string>("");
  const stoppingRef = useRef<boolean>(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Audio-level monitoring: we continuously sample RMS of the live stream
  // with an AnalyserNode and track the peak for the current slice. When the
  // slice ends we compare the peak against the silence threshold and skip
  // transcription if the chunk was effectively silent. This prevents
  // Whisper from hallucinating phrases like "Thank you." / "Thanks for
  // watching." into the transcript whenever the user stops talking.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBufRef = useRef<Float32Array | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const slicePeakRmsRef = useRef<number>(0);
  // Smoothed, instantaneous RMS surfaced to the UI (VU meter). This is a
  // separate ref from slicePeakRmsRef because the UI wants a "live" level
  // that falls back to 0 when silent, while slicePeakRmsRef is a HIGH-water
  // mark across the slice used for the silence gate decision.
  const liveLevelRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupported(
      typeof MediaRecorder !== "undefined" &&
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  const clearSliceTimer = () => {
    if (sliceTimerRef.current != null) {
      window.clearTimeout(sliceTimerRef.current);
      sliceTimerRef.current = null;
    }
  };

  const clearLevelTimer = () => {
    if (levelTimerRef.current != null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
  };

  const teardownAudioGraph = () => {
    clearLevelTimer();
    try {
      analyserRef.current?.disconnect();
    } catch {}
    analyserRef.current = null;
    analyserBufRef.current = null;
    const ctx = audioCtxRef.current;
    if (ctx) {
      // Don't await — close is fire-and-forget.
      void ctx.close().catch(() => {});
    }
    audioCtxRef.current = null;
    slicePeakRmsRef.current = 0;
    liveLevelRef.current = 0;
  };

  const setupAudioGraph = (stream: MediaStream) => {
    teardownAudioGraph();
    try {
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      analyserRef.current = analyser;
      analyserBufRef.current = new Float32Array(analyser.fftSize);
      // Sample at ~20 Hz. Cheap on the main thread and plenty dense for
      // detecting whether any speech occurred inside a 20 s window.
      levelTimerRef.current = window.setInterval(() => {
        const a = analyserRef.current;
        const buf = analyserBufRef.current;
        if (!a || !buf) return;
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > slicePeakRmsRef.current) slicePeakRmsRef.current = rms;
        // Ease the live level toward the current sample. Fast attack, slow
        // release — same shape as a VU meter and makes the bar visually
        // responsive without flickering on tiny fluctuations.
        const prev = liveLevelRef.current;
        const attack = 0.55;
        const release = 0.15;
        const k = rms > prev ? attack : release;
        liveLevelRef.current = prev + (rms - prev) * k;
      }, 50);
    } catch {
      // If the audio graph fails to initialise (rare — blocked autoplay
      // policy, etc.), we just skip silence detection and let the server
      // do the filtering. Transcription still works.
      teardownAudioGraph();
    }
  };

  const startSlice = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = mimeRef.current;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      optsRef.current.onError?.(e as Error);
      return;
    }
    recRef.current = rec;
    chunksRef.current = [];
    chunkStartRef.current = performance.now();
    slicePeakRmsRef.current = 0;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onerror = (e: Event) => {
      const err =
        (e as unknown as { error?: Error }).error ??
        new Error("MediaRecorder error");
      optsRef.current.onError?.(err);
    };
    rec.onstop = () => {
      const durationMs = Math.max(
        0,
        performance.now() - chunkStartRef.current,
      );
      const parts = chunksRef.current;
      chunksRef.current = [];
      const peakRms = slicePeakRmsRef.current;
      // Start the NEXT slice *first* so the MediaStream is capturing again
      // before we hand the previous blob off for transcription. Doing it
      // after the onChunk dispatch leaves a small audio gap between chunks.
      const keepGoing = !stoppingRef.current && !!streamRef.current;
      if (keepGoing) startSlice();
      if (parts.length > 0) {
        const blob = new Blob(parts, {
          type: mime || "audio/webm",
        });
        const threshold = optsRef.current.silenceRmsThreshold ?? 0.015;
        const silent = peakRms > 0 && peakRms < threshold;
        // Minimum viable size check + silence check. If the analyser never
        // initialised, peakRms will be 0 and we skip only the size gate,
        // letting the server-side hallucination filter be the backstop.
        if (blob.size > 800 && !silent) {
          try {
            void optsRef.current.onChunk({
              blob,
              durationMs,
              mime: mime || "audio/webm",
            });
          } catch {}
        }
      }
    };
    rec.start();
    clearSliceTimer();
    sliceTimerRef.current = window.setTimeout(() => {
      if (rec.state === "recording") {
        try {
          rec.stop();
        } catch {}
      }
    }, optsRef.current.timesliceMs);
  }, []);

  const stop = useCallback(() => {
    stoppingRef.current = true;
    clearSliceTimer();
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {}
    }
    const stream = streamRef.current;
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
    }
    streamRef.current = null;
    recRef.current = null;
    chunksRef.current = [];
    teardownAudioGraph();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      mimeRef.current = pickMime();
      stoppingRef.current = false;
      setupAudioGraph(stream);
      setRecording(true);
      startSlice();
    } catch (e) {
      optsRef.current.onError?.(e as Error);
      stop();
    }
  }, [recording, startSlice, stop]);

  const flushNow = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== "recording") return;
    clearSliceTimer();
    try {
      rec.stop();
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      stoppingRef.current = true;
      clearSliceTimer();
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {}
      }
      const stream = streamRef.current;
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
      }
      streamRef.current = null;
      recRef.current = null;
      chunksRef.current = [];
      teardownAudioGraph();
    };
  }, []);

  const level: LevelMeterHandle = useRef<LevelMeterHandle>({
    read: () => liveLevelRef.current,
  }).current;

  return { start, stop, flushNow, recording, supported, level };
}
