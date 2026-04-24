import { NextRequest, NextResponse } from "next/server";
import { GroqError, groqTranscribe, type WhisperSegment } from "@/lib/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whisper is notorious for hallucinating plausible-sounding phrases when
// fed silence, room noise, music, or unintelligible audio. Common patterns
// include "Thank you.", "Thanks for watching.", "Please subscribe.", and
// repeated closing phrases from YouTube-style training data. We filter
// them at three levels:
//   1) per-segment confidence (no_speech_prob / avg_logprob / compression)
//   2) stop-list of known hallucinated phrases (when they are the *entire*
//      output, not just a word inside a longer sentence)
//   3) repetition detection (same phrase repeated >2× is almost always a
//      Whisper loop, not real speech)

const NO_SPEECH_PROB_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;
const COMPRESSION_RATIO_MAX = 2.4;

// Phrases Whisper is documented to emit on silence/noise. We match case-
// and punctuation-insensitively, but only reject if this is the ENTIRE
// transcript — if the user actually said "Thank you." in the middle of a
// sentence we keep it.
const HALLUCINATION_PHRASES: readonly string[] = [
  "thank you",
  "thanks for watching",
  "thanks for listening",
  "please subscribe",
  "subscribe to my channel",
  "like and subscribe",
  "see you next time",
  "bye",
  "bye bye",
  "goodbye",
  "you",
  "yeah",
  "okay",
  "ok",
  "mm",
  "mhm",
  "uh",
  "um",
  ".",
  "...",
  "[music]",
  "[applause]",
  "[silence]",
  "[blank_audio]",
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isKnownHallucination(text: string): boolean {
  const n = normalize(text);
  if (!n) return true;
  if (HALLUCINATION_PHRASES.includes(n)) return true;
  // Very short utterances (<=3 chars) after normalization are almost always
  // Whisper noise ("Y", "Uh", "Hm").
  if (n.length <= 3) return true;
  return false;
}

function isRepetitionLoop(text: string): boolean {
  // "word word word word" or "phrase. phrase. phrase." — Whisper loops.
  const tokens = normalize(text).split(" ").filter(Boolean);
  if (tokens.length < 6) return false;
  const first = tokens[0];
  if (tokens.every((t) => t === first)) return true;
  // bigram repetition
  const bigrams = new Map<string, number>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const bg = `${tokens[i]} ${tokens[i + 1]}`;
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  for (const [, count] of bigrams) {
    if (count >= Math.max(3, Math.floor(tokens.length / 4))) return true;
  }
  return false;
}

function filterSegments(segments: WhisperSegment[]): WhisperSegment[] {
  return segments.filter((s) => {
    if (s.no_speech_prob != null && s.no_speech_prob > NO_SPEECH_PROB_MAX) {
      return false;
    }
    if (s.avg_logprob != null && s.avg_logprob < AVG_LOGPROB_MIN) {
      return false;
    }
    if (
      s.compression_ratio != null &&
      s.compression_ratio > COMPRESSION_RATIO_MAX
    ) {
      return false;
    }
    const text = (s.text ?? "").trim();
    if (!text) return false;
    if (isKnownHallucination(text)) return false;
    return true;
  });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-groq-key") ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing Groq API key. Open Settings and paste your key." },
      { status: 401 },
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    const model =
      (form.get("model") as string | null) ?? "whisper-large-v3";
    const prompt = (form.get("prompt") as string | null) ?? undefined;
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Expected a file field with an audio blob." },
        { status: 400 },
      );
    }
    if (file.size < 800) {
      return NextResponse.json({ text: "", durationMs: 0 });
    }
    const result = await groqTranscribe({
      apiKey,
      model,
      audio: file,
      filename: "chunk.webm",
      prompt,
    });

    const rawText = (result.text ?? "").trim();
    let cleanText = rawText;

    if (result.segments && result.segments.length > 0) {
      const kept = filterSegments(result.segments);
      if (kept.length === 0) {
        cleanText = "";
      } else {
        cleanText = kept
          .map((s) => s.text.trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    } else if (rawText) {
      // Fallback path when no segments were returned (shouldn't happen with
      // verbose_json, but defensive): drop obvious whole-transcript
      // hallucinations.
      if (isKnownHallucination(rawText)) cleanText = "";
    }

    if (cleanText && isRepetitionLoop(cleanText)) {
      cleanText = "";
    }

    return NextResponse.json({
      text: cleanText,
      durationMs: Math.round((result.duration ?? 0) * 1000),
    });
  } catch (e) {
    const status = e instanceof GroqError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status });
  }
}
