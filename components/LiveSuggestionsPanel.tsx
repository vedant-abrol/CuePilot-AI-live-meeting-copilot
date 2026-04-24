"use client";

import { useShallow } from "zustand/react/shallow";
import { pinnedCardRefs, useSessionStore } from "@/lib/sessionStore";
import type { useSessionOrchestrator } from "@/lib/useSessionOrchestrator";
import { SuggestionCardView } from "./SuggestionCard";
import type {
  CardRating,
  SuggestionBatch,
  SuggestionCard,
} from "@/lib/types";
import { getMeetingTypeOption } from "@/lib/defaultSettings";

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LiveSuggestionsPanel({
  orchestrator,
  onCardClick,
}: {
  orchestrator: ReturnType<typeof useSessionOrchestrator>;
  onCardClick: (card: SuggestionCard, batchId: string) => void;
}) {
  const {
    batches,
    isGeneratingSuggestions,
    settings,
    rateCard,
    togglePinCard,
    updateSettings,
  } = useSessionStore(
    useShallow((s) => ({
      batches: s.batches,
      isGeneratingSuggestions: s.isGeneratingSuggestions,
      settings: s.settings,
      rateCard: s.rateCard,
      togglePinCard: s.togglePinCard,
      updateSettings: s.updateSettings,
    })),
  );

  const pinned = pinnedCardRefs(batches);
  const meetingType = getMeetingTypeOption(settings.meetingType);

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-bg-border bg-bg-panel">
      <header className="flex items-center justify-between border-b border-bg-border px-4 py-3">
        <div className="text-xs font-semibold tracking-wide text-text-muted">
          2. LIVE SUGGESTIONS
        </div>
        <div className="text-[10px] font-medium text-text-dim">
          {batches.length} BATCH{batches.length === 1 ? "" : "ES"}
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 border-b border-bg-border px-4 py-2 text-xs">
        <button
          onClick={orchestrator.manualRefresh}
          disabled={isGeneratingSuggestions}
          className="rounded-md border border-bg-border bg-bg-raised px-3 py-1.5 text-[11px] font-medium hover:bg-bg-border disabled:opacity-50"
          title="Flush current audio, then refresh suggestions (R)"
        >
          {isGeneratingSuggestions ? "refreshing…" : "↻ Reload suggestions"}
        </button>
        <div className="flex items-center gap-2 text-[11px] text-text-dim">
          <span
            className="rounded-sm border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
            title={`Meeting type biases which card types get preferred. Change in Settings.\n\n${meetingType.label}: ${meetingType.style.split("\n")[0]}`}
          >
            {meetingType.short}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.autoRefresh}
            onClick={() =>
              updateSettings({ autoRefresh: !settings.autoRefresh })
            }
            title={
              settings.autoRefresh
                ? "Auto-refresh is on. Click to turn off — you'll only get new cards when you click ↻."
                : "Auto-refresh is off. Click to turn on — new cards land after every chunk."
            }
            className={
              "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors " +
              (settings.autoRefresh
                ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                : "border-bg-border bg-bg-raised text-text-dim hover:bg-bg-border hover:text-text")
            }
          >
            <span
              className={
                "inline-block h-1.5 w-1.5 rounded-full " +
                (settings.autoRefresh ? "bg-accent" : "bg-text-dim/60")
              }
            />
            auto-refresh {settings.autoRefresh ? "on" : "off"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {pinned.length > 0 && (
          <PinnedBand
            pinned={pinned}
            onCardClick={onCardClick}
            onRate={rateCard}
            onPinToggle={togglePinCard}
          />
        )}

        {batches.length === 0 && !isGeneratingSuggestions ? (
          <EmptyState chunkSeconds={settings.chunkSeconds} />
        ) : null}

        {isGeneratingSuggestions && batches.length === 0 && (
          <div className="mt-10 space-y-3">
            <div className="shimmer h-24 rounded-lg border border-bg-border" />
            <div className="shimmer h-24 rounded-lg border border-bg-border" />
            <div className="shimmer h-24 rounded-lg border border-bg-border" />
          </div>
        )}

        <ul className="space-y-6">
          {batches.map((batch, i) => (
            <BatchBlock
              key={batch.id}
              batch={batch}
              index={batches.length - i}
              fresh={i === 0}
              onCardClick={onCardClick}
              onRate={rateCard}
              onPinToggle={togglePinCard}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function PinnedBand({
  pinned,
  onCardClick,
  onRate,
  onPinToggle,
}: {
  pinned: { batchId: string; card: SuggestionCard }[];
  onCardClick: (card: SuggestionCard, batchId: string) => void;
  onRate: (batchId: string, cardId: string, rating: CardRating | null) => void;
  onPinToggle: (batchId: string, cardId: string) => void;
}) {
  return (
    <div className="mb-5 rounded-lg border border-accent/30 bg-accent/[0.06] p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent">
        <svg
          viewBox="0 0 16 16"
          className="h-3 w-3"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 1.5v5.5M3.5 7h9l-1.5 3.5h-6L3.5 7zM8 10.5v4" />
        </svg>
        Pinned ({pinned.length})
      </div>
      <div className="space-y-2">
        {pinned.map((p) => (
          <SuggestionCardView
            key={p.card.id}
            card={p.card}
            variant="pinned"
            onClick={() => onCardClick(p.card, p.batchId)}
            onRate={(r) => onRate(p.batchId, p.card.id, r)}
            onPinToggle={() => onPinToggle(p.batchId, p.card.id)}
          />
        ))}
      </div>
    </div>
  );
}

function BatchBlock({
  batch,
  index,
  fresh,
  onCardClick,
  onRate,
  onPinToggle,
}: {
  batch: SuggestionBatch;
  index: number;
  fresh: boolean;
  onCardClick: (card: SuggestionCard, batchId: string) => void;
  onRate: (batchId: string, cardId: string, rating: CardRating | null) => void;
  onPinToggle: (batchId: string, cardId: string) => void;
}) {
  const isFallback =
    batch.plannerNote?.toLowerCase().startsWith("fallback") ?? false;
  return (
    <li>
      <div className="mb-2 flex items-center gap-3 text-[10px] uppercase tracking-wider text-text-dim">
        <span>BATCH {index}</span>
        <span>·</span>
        <span>{fmtTime(batch.t)}</span>
        {batch.latencyMs != null && (
          <>
            <span>·</span>
            <span>{batch.latencyMs}ms</span>
          </>
        )}
        {fresh && (
          <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            NEW
          </span>
        )}
        {isFallback && (
          <span className="rounded-sm bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
            FALLBACK
          </span>
        )}
      </div>
      {isFallback && batch.plannerNote && (
        <div
          className="mb-2 rounded-md border border-rose-500/20 bg-rose-500/5 px-2 py-1.5 text-[10px] leading-snug text-rose-200/80"
          title={batch.plannerNote}
        >
          {batch.plannerNote}
        </div>
      )}
      <div className="space-y-3">
        {batch.cards.map((c) => (
          <SuggestionCardView
            key={c.id}
            card={c}
            onClick={() => onCardClick(c, batch.id)}
            onRate={(r) => onRate(batch.id, c.id, r)}
            onPinToggle={() => onPinToggle(batch.id, c.id)}
          />
        ))}
      </div>
    </li>
  );
}

function EmptyState({ chunkSeconds }: { chunkSeconds: number }) {
  return (
    <div className="mt-6 rounded-md border border-accent/20 bg-accent/5 p-3 text-[11px] leading-snug text-text-muted">
      On refresh (or auto every ~{chunkSeconds}s), we generate{" "}
      <b>3 fresh suggestions</b> from recent transcript context. New batches
      appear at the top; older batches stay visible below. Each card is a
      tappable preview:{" "}
      <span className="text-type-question">question to ask</span>,{" "}
      <span className="text-type-talking">talking point</span>,{" "}
      <span className="text-type-answer">answer</span>,{" "}
      <span className="text-type-fact">fact check</span>, or{" "}
      <span className="text-type-clarify">clarifying info</span>. The preview
      alone should already deliver value.
    </div>
  );
}
