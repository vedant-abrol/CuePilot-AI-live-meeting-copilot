"use client";

import clsx from "clsx";
import { useState } from "react";
import type {
  CardRating,
  SuggestionCard as CardT,
  SuggestionType,
} from "@/lib/types";

const TYPE_META: Record<
  SuggestionType,
  { label: string; badge: string; accent: string }
> = {
  question_to_ask: {
    label: "QUESTION TO ASK",
    badge: "bg-type-question/15 text-type-question border-type-question/40",
    accent: "hover:border-type-question/50",
  },
  talking_point: {
    label: "TALKING POINT",
    badge: "bg-type-talking/15 text-type-talking border-type-talking/40",
    accent: "hover:border-type-talking/50",
  },
  answer: {
    label: "ANSWER",
    badge: "bg-type-answer/15 text-type-answer border-type-answer/40",
    accent: "hover:border-type-answer/50",
  },
  fact_check: {
    label: "FACT CHECK",
    badge: "bg-type-fact/15 text-type-fact border-type-fact/40",
    accent: "hover:border-type-fact/50",
  },
  clarifying_info: {
    label: "CLARIFYING INFO",
    badge: "bg-type-clarify/15 text-type-clarify border-type-clarify/40",
    accent: "hover:border-type-clarify/50",
  },
};

export function SuggestionCardView({
  card,
  onClick,
  onRate,
  onPinToggle,
  disabled,
  isPinned,
  variant,
}: {
  card: CardT;
  onClick: () => void;
  onRate?: (rating: CardRating | null) => void;
  onPinToggle?: () => void;
  disabled?: boolean;
  // When true, render the small "PINNED" label instead of the "Opened" one
  // regardless of the card state (used by the pinned-sticky panel).
  isPinned?: boolean;
  // "feed" is the normal batch rendering; "pinned" is the sticky band at the
  // top of the suggestions panel — slightly more compact and with a
  // different accent so it's visually distinct from a fresh batch.
  variant?: "feed" | "pinned";
}) {
  const meta = TYPE_META[card.type];
  const [showRationale, setShowRationale] = useState(false);
  const hasRationale = !!card.rationale && card.rationale.trim().length > 0;
  const rating: CardRating | null = card.rating ?? null;
  const pinned = isPinned ?? !!card.pinned;

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      // Don't steal Space/Enter when focus is on one of our inner buttons
      // (pin / thumb / info). Those buttons already handle their own events.
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "BUTTON") return;
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && onClick()}
      onKeyDown={handleKey}
      className={clsx(
        "group relative w-full rounded-lg border bg-bg-raised px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        disabled && "cursor-not-allowed opacity-60",
        !disabled && "cursor-pointer",
        pinned
          ? "border-accent/40 bg-accent/5"
          : card.used
            ? "border-bg-border opacity-75"
            : "border-bg-border hover:bg-[#1c2030]",
        !card.used && !pinned && meta.accent,
        variant === "pinned" && "py-2.5",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <span
          className={clsx(
            "rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider",
            meta.badge,
          )}
        >
          {meta.label}
        </span>
        <div className="flex items-center gap-0.5">
          {card.used && !pinned && (
            <span className="mr-1 text-[10px] uppercase tracking-wide text-text-dim">
              Opened
            </span>
          )}
          {pinned && (
            <span className="mr-1 text-[10px] uppercase tracking-wide text-accent">
              Pinned
            </span>
          )}
          {hasRationale && (
            <IconButton
              label="Why this card?"
              active={showRationale}
              onClick={(e) => {
                e.stopPropagation();
                setShowRationale((v) => !v);
              }}
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7.2v3.6" />
                <circle cx="8" cy="5.1" r="0.7" fill="currentColor" />
              </svg>
            </IconButton>
          )}
          {onRate && (
            <>
              <IconButton
                label={rating === "up" ? "Remove upvote" : "This card was useful"}
                active={rating === "up"}
                onClick={(e) => {
                  e.stopPropagation();
                  onRate(rating === "up" ? null : "up");
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill={rating === "up" ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4.5 13.5V7M4.5 7l2.8-4.4c.3-.5.9-.7 1.4-.4.5.3.7.9.5 1.5l-.7 2.3h3.6c1 0 1.8.9 1.5 1.9l-1.1 4.4c-.2.7-.8 1.2-1.5 1.2H4.5z" />
                </svg>
              </IconButton>
              <IconButton
                label={
                  rating === "down"
                    ? "Remove downvote"
                    : "Not useful — avoid cards like this next time"
                }
                active={rating === "down"}
                tone="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onRate(rating === "down" ? null : "down");
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill={rating === "down" ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M11.5 2.5V9M11.5 9l-2.8 4.4c-.3.5-.9.7-1.4.4-.5-.3-.7-.9-.5-1.5l.7-2.3H3.9c-1 0-1.8-.9-1.5-1.9l1.1-4.4c.2-.7.8-1.2 1.5-1.2h6.5z" />
                </svg>
              </IconButton>
            </>
          )}
          {onPinToggle && (
            <IconButton
              label={pinned ? "Unpin" : "Pin — keeps this card at the top of the feed"}
              active={pinned}
              onClick={(e) => {
                e.stopPropagation();
                onPinToggle();
              }}
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill={pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 1.5v5.5M3.5 7h9l-1.5 3.5h-6L3.5 7zM8 10.5v4" />
              </svg>
            </IconButton>
          )}
        </div>
      </div>
      <div className="text-sm leading-snug text-text">{card.preview}</div>
      {hasRationale && showRationale && (
        <div className="mt-2 rounded-md border border-bg-border/80 bg-bg/60 px-2.5 py-1.5 text-[11px] leading-snug text-text-muted">
          <span className="mr-1 font-semibold text-text-dim">Why:</span>
          {card.rationale}
        </div>
      )}
    </div>
  );
}

function IconButton({
  children,
  label,
  active,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  tone?: "default" | "danger";
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "grid h-6 w-6 shrink-0 place-items-center rounded-md border border-transparent text-text-dim transition hover:border-bg-border hover:bg-bg/60 hover:text-text",
        active &&
          tone === "danger" &&
          "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200",
        active &&
          tone !== "danger" &&
          "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 hover:text-accent",
      )}
    >
      {children}
    </button>
  );
}
