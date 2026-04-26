import { NextRequest, NextResponse } from "next/server";
import { GroqError, groqChatJSON } from "@/lib/groq";
import {
  SuggestionBatchRawSchema,
  SuggestionCardRawSchema,
  type SuggestionBatchRaw,
  type SuggestionCardRaw,
} from "@/lib/schemas";
import { buildFallbackCards, buildSuggestionsUser } from "@/lib/prompts";
import { findDuplicates } from "@/lib/dedupe";
import { getMeetingTypeOption } from "@/lib/defaultSettings";
import type { MeetingBrief, MeetingType, SuggestionCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  settings: {
    suggestionModel: string;
    plannerSystemPrompt: string;
    generatorSystemPrompt: string;
    suggestionContextChars: number;
    meetingType?: MeetingType;
  };
  transcriptTail: string;
  brief: MeetingBrief | null;
  recentPreviews: string[];
  downvotedPreviews?: string[];
}

function cardsFromRaw(
  raw: SuggestionBatchRaw,
): Array<Omit<SuggestionCard, "id">> {
  return raw.cards.slice(0, 3).map((c) => ({
    type: c.type,
    preview: c.preview.trim(),
    expandedSeed: c.expanded_seed.trim(),
    confidence: c.confidence,
    rationale: c.rationale?.trim() || undefined,
  }));
}

// The generator prompt defines a {cards: [...]} schema, but GPT-OSS-120B
// often wraps its output under a different top-level key (batch, result,
// data, suggestions) or returns a bare array, or nests under a second
// object. This coerces anything card-shaped back to { cards: [...] } so
// a single schema parse works across model quirks.
function coerceToCardsShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.cards)) return obj;
  if (Array.isArray(raw)) return { cards: raw };
  const KEYS = [
    "cards",
    "suggestions",
    "items",
    "results",
    "output",
    "batch",
    "data",
    "result",
    "response",
    "payload",
  ];
  for (const k of KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) return { cards: v };
    if (v && typeof v === "object") {
      const vo = v as Record<string, unknown>;
      if (Array.isArray(vo.cards)) return { cards: vo.cards };
      const firstArr = Object.values(vo).find(Array.isArray);
      if (firstArr) return { cards: firstArr };
    }
  }
  // Last resort: grab the first array-valued property we see.
  const firstArr = Object.values(obj).find(Array.isArray);
  if (firstArr) return { cards: firstArr };
  return obj;
}

// Some models emit a single card inline at the top level, or emit snake_case
// variants of our keys (e.g. "expanded" instead of "expanded_seed"). Try a
// mild repair per-card so one sloppy field doesn't nuke the whole batch.
function repairCard(c: unknown): SuggestionCardRaw | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return "";
  };
  const preview = pick("preview", "text", "content", "card", "title", "body");
  const expanded = pick(
    "expanded_seed",
    "expandedSeed",
    "expanded",
    "seed",
    "followup",
    "follow_up",
    "prompt",
    "question",
  );
  const typeRaw = pick("type", "kind", "category", "slot");
  let typeGuess = typeRaw.toLowerCase().replace(/[\s-]+/g, "_");
  const typeMap: Record<string, SuggestionCardRaw["type"]> = {
    question: "question_to_ask",
    ask: "question_to_ask",
    question_to_ask: "question_to_ask",
    talking: "talking_point",
    talking_point: "talking_point",
    comment: "talking_point",
    answer: "answer",
    response: "answer",
    fact: "fact_check",
    fact_check: "fact_check",
    factcheck: "fact_check",
    clarify: "clarifying_info",
    clarifying: "clarifying_info",
    clarifying_info: "clarifying_info",
    info: "clarifying_info",
    definition: "clarifying_info",
  };
  const type = typeMap[typeGuess] ?? null;
  const confRaw = o.confidence;
  const confidence =
    typeof confRaw === "number"
      ? Math.max(0, Math.min(1, confRaw))
      : typeof confRaw === "string" && Number.isFinite(Number(confRaw))
        ? Math.max(0, Math.min(1, Number(confRaw)))
        : 0.5;
  const rationale = pick("rationale", "reason", "why", "explanation");
  if (!type || !preview || !expanded) return null;
  const candidate = {
    type,
    preview: preview.slice(0, 495),
    expanded_seed: expanded.slice(0, 595),
    confidence,
    rationale: rationale.slice(0, 395) || "",
  };
  const parsed = SuggestionCardRawSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function attemptParseToBatch(raw: unknown): SuggestionBatchRaw | null {
  const shaped = coerceToCardsShape(raw);
  const direct = SuggestionBatchRawSchema.safeParse(shaped);
  if (direct.success) return direct.data;
  // Try per-card repair.
  const asObj = shaped as { cards?: unknown };
  if (asObj && Array.isArray(asObj.cards)) {
    const repaired: SuggestionCardRaw[] = [];
    for (const c of asObj.cards) {
      const r = repairCard(c);
      if (r) repaired.push(r);
      if (repaired.length >= 3) break;
    }
    if (repaired.length >= 3) return { cards: repaired };
  }
  return null;
}

// Robust schema reminder we *append* to whatever generator prompt the user
// has in settings. The default generator prompt uses literal `"..."`
// placeholders in its example, which GPT-OSS-120B sometimes copies verbatim.
// This concrete example fixes that.
const SCHEMA_HARDENER = `

================
OUTPUT CONTRACT (authoritative — overrides any earlier example):
Return ONE JSON object with exactly this shape. No prose before or after. No markdown. Do not copy the example values below.

{
  "cards": [
    {
      "type": "question_to_ask",
      "preview": "Concrete sentence or question grounded in what was just said.",
      "expanded_seed": "A natural-language prompt the user would send to ask for a deeper answer on this.",
      "confidence": 0.72,
      "rationale": "One short sentence on why this fits right now."
    },
    {
      "type": "clarifying_info",
      "preview": "Definition / expansion of an acronym or jargon term that came up.",
      "expanded_seed": "Explain <term> in ~120 words given this conversation context.",
      "confidence": 0.7,
      "rationale": "Jargon just used; user may want a refresher."
    },
    {
      "type": "talking_point",
      "preview": "A specific claim, angle, or example the user could contribute.",
      "expanded_seed": "Help me phrase and back up this talking point in this meeting.",
      "confidence": 0.65,
      "rationale": "Moves the discussion forward on the current topic."
    }
  ]
}

RULES:
- type MUST be one of: question_to_ask, talking_point, answer, fact_check, clarifying_info.
- Output EXACTLY 3 cards (no more, no less).
- Every card MUST have ALL fields: type, preview, expanded_seed, confidence, rationale.
- preview MUST reference something specific from the transcript or brief (names, numbers, terms actually said). Do NOT emit generic filler like "What's the biggest risk?" or "Summarize the core decision."
- No text outside the JSON object. No trailing commas. No code fences.
================`;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-groq-key") ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing Groq API key. Open Settings and paste your key." },
      { status: 401 },
    );
  }
  const started = Date.now();
  try {
    const body = (await req.json()) as Body;
    const {
      settings,
      transcriptTail,
      brief,
      recentPreviews,
      downvotedPreviews,
    } = body;

    const system = settings.generatorSystemPrompt + SCHEMA_HARDENER;
    const meetingStyle = getMeetingTypeOption(
      (settings.meetingType ?? "general") as MeetingType,
    ).style;
    const user = buildSuggestionsUser({
      transcriptTail,
      brief,
      recentPreviews,
      plannerRules: settings.plannerSystemPrompt,
      meetingStyle,
      downvotedPreviews,
    });

    let cards: Array<Omit<SuggestionCard, "id">> | null = null;
    let plannerNote = "";
    let lastError = "";
    let rawPreview = "";

    try {
      const raw = await groqChatJSON<unknown>({
        apiKey,
        model: settings.suggestionModel,
        system,
        user,
        temperature: 0.6,
        maxTokens: 1400,
        timeoutMs: 15000,
      });
      rawPreview = safePreview(raw);
      const batch = attemptParseToBatch(raw);
      if (batch) {
        cards = cardsFromRaw(batch);
      } else {
        lastError = describeParseFailure(raw);
        const repairRaw = await groqChatJSON<unknown>({
          apiKey,
          model: settings.suggestionModel,
          system,
          user:
            user +
            '\n\nSTRICT REPAIR: Your previous output did not match the contract. Re-emit ONLY the top-level JSON object {"cards":[ {type, preview, expanded_seed, confidence, rationale}, {..}, {..} ]}. Exactly 3 cards, transcript-grounded, no prose, no code fences, no extra keys.',
          temperature: 0.2,
          maxTokens: 1400,
          timeoutMs: 13000,
        });
        const repairedBatch = attemptParseToBatch(repairRaw);
        if (repairedBatch) {
          cards = cardsFromRaw(repairedBatch);
        } else {
          lastError = "schema-miss-after-repair: " + describeParseFailure(repairRaw);
        }
      }

      // Freshness check: if any card duplicates a recent preview (normalized
      // Jaccard >= 0.55), regenerate ONCE with an explicit "avoid these exact
      // previews" hint. GPT-OSS-120B occasionally recycles the same framing
      // for adjacent batches even with the "these ideas are stale" note in
      // the user prompt; an explicit avoid-list almost always fixes it.
      if (cards && recentPreviews.length > 0) {
        const dupes = findDuplicates(
          cards.map((c) => c.preview),
          recentPreviews,
          0.55,
        );
        if (dupes.length > 0) {
          try {
            const freshRaw = await groqChatJSON<unknown>({
              apiKey,
              model: settings.suggestionModel,
              system,
              user:
                user +
                "\n\nAVOID THESE PREVIOUS PREVIEWS (your last draft overlapped too closely with them — pick genuinely different angles, different card types if needed):\n" +
                [...recentPreviews, ...dupes]
                  .map((p, i) => `${i + 1}. ${p}`)
                  .join("\n"),
              temperature: 0.7,
              maxTokens: 1400,
              timeoutMs: 12000,
            });
            const freshBatch = attemptParseToBatch(freshRaw);
            if (freshBatch) {
              const freshCards = cardsFromRaw(freshBatch);
              const stillDupes = findDuplicates(
                freshCards.map((c) => c.preview),
                recentPreviews,
                0.55,
              );
              if (stillDupes.length < dupes.length) {
                cards = freshCards;
              }
            }
          } catch {
            /* keep original batch on dedupe retry failure */
          }
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : "unknown";
    }

    if (!cards) {
      cards = buildFallbackCards(brief);
      plannerNote = rawPreview
        ? `fallback (${lastError || "unknown"}): ${rawPreview.slice(0, 140)}`
        : `fallback (${lastError || "unknown"})`;
    }

    return NextResponse.json({
      batch: {
        cards,
        plannerNote,
        latencyMs: Date.now() - started,
      },
    });
  } catch (e) {
    const status = e instanceof GroqError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status });
  }
}

function safePreview(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s ? s.slice(0, 400) : "";
  } catch {
    return String(v).slice(0, 400);
  }
}

function describeParseFailure(raw: unknown): string {
  const shaped = coerceToCardsShape(raw);
  const attempt = SuggestionBatchRawSchema.safeParse(shaped);
  if (attempt.success) return "coerce-ok-but-downstream-failed";
  const issue = attempt.error.issues[0];
  const path = issue?.path?.join(".") || "(root)";
  return `zod: ${issue?.code ?? "unknown"} at ${path} — ${(issue?.message ?? "").slice(0, 80)}`;
}
