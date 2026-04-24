"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useSessionStore, transcriptTail } from "@/lib/sessionStore";
import { callChatStream } from "@/lib/clientApi";
import type { ChatMessage, SuggestionCard } from "@/lib/types";

export interface ChatPanelHandle {
  sendCard: (card: SuggestionCard) => void;
}

// Tiny helper so copy works in dev (no https) and in prod without forcing
// a Clipboard API permission prompt. Falls back to a hidden textarea.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel() {
  const chat = useSessionStore((s) => s.chat);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.length, chat[chat.length - 1]?.content]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const sendInternal = async (payload: {
    card?: SuggestionCard;
    message?: string;
  }) => {
    const s = useSessionStore.getState();
    if (!s.settings.apiKey) {
      s.setError("Paste your Groq API key in Settings to chat.");
      s.openSettings();
      return;
    }
    const displayText = payload.card
      ? `${labelFor(payload.card.type)}: ${payload.card.preview}`
      : payload.message ?? "";
    if (!displayText.trim()) return;

    // Cleanly close any previously in-flight stream before starting a new
    // one. Clicking a second suggestion while the first answer is still
    // streaming used to leak an AbortError into the React error overlay
    // because the prior stream's fetch rejected without a handler; now we
    // (a) mark any still-streaming assistant message as finished so the
    // caret stops blinking, and (b) abort the old controller after nulling
    // the ref so the rejection we trigger has nowhere to bubble unhandled.
    const prior = abortRef.current;
    abortRef.current = null;
    if (prior) {
      const chat = useSessionStore.getState().chat;
      for (const m of chat) {
        if (m.streaming) {
          useSessionStore.getState().updateChatMessage(m.id, {
            streaming: false,
          });
        }
      }
      try {
        prior.abort();
      } catch {}
    }

    const userMsg = useSessionStore.getState().addChatMessage({
      t: Date.now(),
      role: "user",
      content: displayText,
      triggeredByCardId: payload.card?.id,
    });
    const assistantMsg = useSessionStore.getState().addChatMessage({
      t: Date.now(),
      role: "assistant",
      content: "",
      streaming: true,
    });
    setSending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const history = useSessionStore
      .getState()
      .chat.filter(
        (m) =>
          m.id !== userMsg.id && m.id !== assistantMsg.id && m.role !== "system",
      );
    try {
      await callChatStream({
        apiKey: s.settings.apiKey,
        settings: {
          chatModel: s.settings.chatModel,
          chatSystemPrompt: s.settings.chatSystemPrompt,
          chatContextChars: s.settings.chatContextChars,
        },
        brief: s.brief,
        transcriptTail: transcriptTail(
          s.transcript,
          s.settings.chatContextChars,
        ),
        history,
        card: payload.card,
        message: payload.message,
        signal: ctrl.signal,
        cb: {
          onFirstToken: (ms) => {
            useSessionStore.getState().updateChatMessage(assistantMsg.id, {
              firstTokenMs: Math.round(ms),
            });
            useSessionStore.getState().setLastFirstTokenMs(Math.round(ms));
          },
          onToken: (chunk) => {
            useSessionStore.getState().appendChatContent(assistantMsg.id, chunk);
          },
          onDone: (totalMs) => {
            useSessionStore.getState().updateChatMessage(assistantMsg.id, {
              streaming: false,
              totalMs: Math.round(totalMs),
            });
            if (abortRef.current === ctrl) {
              abortRef.current = null;
              setSending(false);
            }
          },
          onAbort: () => {
            // The user superseded this request with a newer one. Don't mark
            // the message with an error — just stop the caret. The newer
            // request owns `sending` / `abortRef` now, so don't touch them.
            useSessionStore.getState().updateChatMessage(assistantMsg.id, {
              streaming: false,
            });
          },
          onError: (err) => {
            const existing =
              useSessionStore
                .getState()
                .chat.find((m) => m.id === assistantMsg.id)?.content ?? "";
            useSessionStore.getState().updateChatMessage(assistantMsg.id, {
              streaming: false,
              content: existing
                ? `${existing}\n\n[error] ${err.message}`
                : `[error] ${err.message}`,
            });
            if (abortRef.current === ctrl) {
              abortRef.current = null;
              setSending(false);
            }
          },
        },
      });
    } catch (e) {
      // Belt-and-suspenders: callChatStream should never throw now, but if
      // it somehow does (e.g. a future refactor regresses the guards),
      // keep the UI responsive instead of popping a runtime error overlay.
      const msg = e instanceof Error ? e.message : String(e);
      const existing =
        useSessionStore
          .getState()
          .chat.find((m) => m.id === assistantMsg.id)?.content ?? "";
      useSessionStore.getState().updateChatMessage(assistantMsg.id, {
        streaming: false,
        content: existing
          ? `${existing}\n\n[error] ${msg}`
          : `[error] ${msg}`,
      });
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setSending(false);
      }
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendInternal({ message: text });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-panel">
      <header className="flex items-center justify-between border-b border-bg-border px-4 py-3">
        <div className="text-xs font-semibold tracking-wide text-text-muted">
          3. CHAT (DETAILED ANSWERS)
        </div>
        <div className="text-[10px] font-medium text-text-dim">SESSION-ONLY</div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        id="chat-scroll"
      >
        {chat.length === 0 ? (
          <EmptyChat />
        ) : (
          <ul className="space-y-4">
            {chat.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                onReAsk={(text) => {
                  setInput(text);
                  // Focus + place caret at the end so the user can tweak and
                  // hit Enter immediately. requestAnimationFrame avoids a
                  // race where the textarea doesn't have the new value yet.
                  window.requestAnimationFrame(() => {
                    const el = inputRef.current;
                    if (!el) return;
                    el.focus();
                    const len = el.value.length;
                    try {
                      el.setSelectionRange(len, len);
                    } catch {}
                  });
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-bg-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              const composing = (e.nativeEvent as KeyboardEvent).isComposing;
              if (
                (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
                (e.key === "Enter" && !e.shiftKey && !composing)
              ) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask anything…"
            className="flex-1 resize-none rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm outline-none placeholder:text-text-dim focus:border-accent/60"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className={clsx(
              "rounded-md px-4 py-2 text-sm font-medium transition",
              sending || !input.trim()
                ? "bg-bg-border text-text-dim"
                : "bg-accent text-white hover:bg-accent-soft",
            )}
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>

      <ChatPanelController onCardClick={(card) => void sendInternal({ card })} />
    </section>
  );
}

function labelFor(type: SuggestionCard["type"]): string {
  switch (type) {
    case "question_to_ask":
      return "Question to ask";
    case "talking_point":
      return "Talking point";
    case "answer":
      return "Answer";
    case "fact_check":
      return "Fact check";
    case "clarifying_info":
      return "Clarifying info";
  }
}

function MessageBubble({
  msg,
  onReAsk,
}: {
  msg: ChatMessage;
  onReAsk: (text: string) => void;
}) {
  const isUser = msg.role === "user";
  const [copied, setCopied] = useState<"plain" | "quote" | null>(null);
  const hasContent = msg.content.trim().length > 0;

  const flashCopied = (which: "plain" | "quote") => {
    setCopied(which);
    window.setTimeout(() => {
      setCopied((prev) => (prev === which ? null : prev));
    }, 1100);
  };

  const asQuote = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((l) => `> ${l}`)
      .join("\n");

  // "Re-ask" means different things for user vs assistant bubbles:
  // - On a user bubble: drop the original user message (or card preview) back
  //   into the input so the user can tweak phrasing and resend.
  // - On an assistant bubble: seed the input with "Rephrase:\n> ..." so the
  //   user can ask for a different answer in their own words.
  const reAskText = (): string => {
    if (isUser) return msg.content;
    return `Rephrase / ask differently:\n${asQuote(msg.content)}\n\n`;
  };

  return (
    <li className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "group max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
          isUser
            ? msg.triggeredByCardId
              ? "bg-accent/15 text-text border border-accent/30"
              : "bg-accent text-white"
            : "bg-bg-raised text-text border border-bg-border",
        )}
      >
        <div className="text-[13.5px] leading-[1.55]">
          {isUser ? (
            <div className="whitespace-pre-wrap">{msg.content}</div>
          ) : (
            <Markdown source={msg.content} />
          )}
          {msg.streaming && <span className="caret-blink ml-0.5">▍</span>}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-dim">
          <span>
            {fmtTime(msg.t)}
            {msg.firstTokenMs != null && (
              <> · {msg.firstTokenMs}ms to first token</>
            )}
          </span>
          {hasContent && !msg.streaming && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <BubbleAction
                label="Copy"
                active={copied === "plain"}
                activeLabel="Copied"
                isUser={isUser}
                onClick={async () => {
                  const ok = await copyToClipboard(msg.content);
                  if (ok) flashCopied("plain");
                }}
              />
              {!isUser && (
                <BubbleAction
                  label="Copy as quote"
                  active={copied === "quote"}
                  activeLabel="Copied"
                  isUser={isUser}
                  onClick={async () => {
                    const ok = await copyToClipboard(asQuote(msg.content));
                    if (ok) flashCopied("quote");
                  }}
                />
              )}
              <BubbleAction
                label={isUser ? "Re-ask" : "Ask in your own words"}
                isUser={isUser}
                onClick={() => onReAsk(reAskText())}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function BubbleAction({
  label,
  activeLabel,
  active,
  isUser,
  onClick,
}: {
  label: string;
  activeLabel?: string;
  active?: boolean;
  isUser: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void onClick();
      }}
      className={clsx(
        "rounded-sm border border-transparent px-1.5 py-0.5 text-[10px] font-medium transition",
        isUser
          ? "text-white/80 hover:border-white/30 hover:bg-white/10 hover:text-white"
          : "text-text-dim hover:border-bg-border hover:bg-bg/60 hover:text-text",
        active && "text-emerald-400 hover:text-emerald-300",
      )}
    >
      {active ? activeLabel ?? label : label}
    </button>
  );
}

function EmptyChat() {
  return (
    <div className="mt-10 space-y-4 text-sm text-text-muted">
      <div className="rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] leading-snug">
        Clicking a suggestion adds it to this chat and streams a detailed
        answer (separate prompt, more context). You can also type questions
        directly. One continuous chat per session — no login, no persistence.
      </div>
      <div className="text-center text-xs text-text-dim">
        Click a suggestion or type a question below.
      </div>
    </div>
  );
}

function ChatPanelController({
  onCardClick,
}: {
  onCardClick: (card: SuggestionCard) => void;
}) {
  useEffect(() => {
    chatEventBus.handler = onCardClick;
    return () => {
      if (chatEventBus.handler === onCardClick) chatEventBus.handler = null;
    };
  }, [onCardClick]);
  return null;
}

export const chatEventBus: { handler: ((c: SuggestionCard) => void) | null } = {
  handler: null,
};

// --- Minimal, dependency-free markdown renderer ----------------------------
// Supports what the chat model is asked to produce: paragraphs, **bold**,
// *italics*, `inline code`, fenced code blocks, small headings, and short
// bullet / numbered lists. Pipe-tables (which the prompt tells the model not
// to emit but GPT-OSS occasionally slips in) are rendered as preformatted
// text rather than being dumped as raw pipes in the middle of prose.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const seg = m[0];
    if (seg.startsWith("**")) {
      out.push(
        <strong key={`${keyPrefix}-b-${i++}`} className="font-semibold text-text">
          {seg.slice(2, -2)}
        </strong>,
      );
    } else if (seg.startsWith("`")) {
      out.push(
        <code
          key={`${keyPrefix}-c-${i++}`}
          className="rounded bg-bg-border/70 px-1 py-0.5 font-mono text-[12px]"
        >
          {seg.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={`${keyPrefix}-i-${i++}`} className="italic">
          {seg.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + seg.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isListStart(line: string): "ul" | "ol" | null {
  if (/^\s*[-*]\s+/.test(line)) return "ul";
  if (/^\s*\d+\.\s+/.test(line)) return "ol";
  return null;
}

function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("```")) {
        codeLines.push(lines[j]);
        j++;
      }
      blocks.push(
        <pre
          key={`cb-${k++}`}
          className="my-1 overflow-x-auto rounded-md border border-bg-border bg-bg/60 px-2 py-1.5 font-mono text-[12px] leading-relaxed"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      i = j + 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 3);
      const size = level === 1 ? "text-[14px]" : "text-[13px]";
      blocks.push(
        <div
          key={`h-${k++}`}
          className={clsx("mt-2 font-semibold first:mt-0", size)}
        >
          {renderInline(h[2].replace(/\s+#+\s*$/, ""), `h${k}`)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) {
      blocks.push(
        <div
          key={`hr-${k++}`}
          className="my-2 h-px w-full bg-bg-border/70"
        />,
      );
      i++;
      continue;
    }
    const listKind = isListStart(line);
    if (listKind) {
      const items: string[] = [];
      while (i < lines.length) {
        const kind = isListStart(lines[i]);
        if (kind !== listKind) break;
        const m = listKind === "ul"
          ? /^\s*[-*]\s+(.*)$/.exec(lines[i])
          : /^\s*\d+\.\s+(.*)$/.exec(lines[i]);
        items.push(m?.[1] ?? lines[i]);
        i++;
      }
      const ListTag = listKind === "ol" ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={`ls-${k++}`}
          className={clsx(
            "my-1 space-y-0.5 pl-4",
            listKind === "ol" ? "list-decimal" : "list-disc",
          )}
        >
          {items.map((it, idx) => (
            <li key={idx} className="pl-0.5">
              {renderInline(it, `li-${k}-${idx}`)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre
          key={`t-${k++}`}
          className="my-1 overflow-x-auto rounded-md border border-bg-border bg-bg/60 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed"
        >
          {tableLines.join("\n")}
        </pre>,
      );
      continue;
    }
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === "") break;
      if (l.startsWith("```") || /^(#{1,6})\s+/.test(l)) break;
      if (isListStart(l)) break;
      if (l.trim().startsWith("|")) break;
      if (/^\s*-{3,}\s*$/.test(l)) break;
      paraLines.push(l);
      j++;
    }
    blocks.push(
      <p key={`p-${k++}`} className="my-1 whitespace-pre-wrap">
        {renderInline(paraLines.join(" "), `p-${k}`)}
      </p>,
    );
    i = j;
  }
  return <div className="space-y-0.5">{blocks}</div>;
}
