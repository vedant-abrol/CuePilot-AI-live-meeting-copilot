import { NextRequest } from "next/server";
import { GroqError, groqChatStream } from "@/lib/groq";
import {
  buildChatUserForCard,
  buildChatUserForFreeform,
} from "@/lib/prompts";
import type { ChatMessage, MeetingBrief, SuggestionCard } from "@/lib/types";

export const runtime = "edge";
export const dynamic = "force-dynamic";

interface Body {
  settings: {
    chatModel: string;
    chatSystemPrompt: string;
    chatContextChars: number;
  };
  brief: MeetingBrief | null;
  transcriptTail: string;
  history: Pick<ChatMessage, "role" | "content">[];
  card: SuggestionCard | null;
  message: string | null;
}

function sseEncode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-groq-key") ?? "";
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing Groq API key." }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { settings, brief, transcriptTail, history, card, message } = body;

  const lastUser = card
    ? buildChatUserForCard({ brief, transcriptTail, card })
    : buildChatUserForFreeform({
        brief,
        transcriptTail,
        message: message ?? "",
      });

  const messages = [
    { role: "system" as const, content: settings.chatSystemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: lastUser },
  ];

  let upstream: Response;
  try {
    upstream = await groqChatStream({
      apiKey,
      model: settings.chatModel,
      messages,
      temperature: 0.45,
      maxTokens: 450,
    });
  } catch (e) {
    const status = e instanceof GroqError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!upstream.body) {
    return new Response(JSON.stringify({ error: "No upstream stream." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
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
            if (payload === "[DONE]") {
              controller.enqueue(
                new TextEncoder().encode("data: [DONE]\n\n"),
              );
              continue;
            }
            try {
              const obj = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const delta = obj.choices?.[0]?.delta?.content ?? "";
              if (delta) controller.enqueue(sseEncode({ delta }));
            } catch {}
          }
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "stream error";
        controller.enqueue(sseEncode({ error: msg }));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
