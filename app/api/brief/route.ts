import { NextRequest, NextResponse } from "next/server";
import { GroqError, groqChatJSON } from "@/lib/groq";
import { MeetingBriefSchema } from "@/lib/schemas";
import { buildBriefUser } from "@/lib/prompts";
import type { MeetingBrief } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  settings: {
    suggestionModel: string;
    briefSystemPrompt: string;
    briefContextChars: number;
  };
  previousBrief: MeetingBrief | null;
  transcriptWindow: string;
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-groq-key") ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing Groq API key." },
      { status: 401 },
    );
  }
  try {
    const body = (await req.json()) as Body;
    const user = buildBriefUser({
      previousBrief: body.previousBrief,
      transcriptWindow: body.transcriptWindow,
    });
    const raw = await groqChatJSON<unknown>({
      apiKey,
      model: body.settings.suggestionModel,
      system: body.settings.briefSystemPrompt,
      user,
      temperature: 0.2,
      maxTokens: 380,
      timeoutMs: 9000,
    });
    const parsed = MeetingBriefSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid brief JSON from model." },
        { status: 502 },
      );
    }
    const d = parsed.data;
    return NextResponse.json({
      brief: {
        topic: d.topic,
        goal: d.goal,
        participants: d.participants,
        openQuestions: d.open_questions,
        keyFacts: d.key_facts,
      },
    });
  } catch (e) {
    const status = e instanceof GroqError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status });
  }
}
