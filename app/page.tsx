"use client";

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Header } from "@/components/Header";
import { MicTranscriptPanel } from "@/components/MicTranscriptPanel";
import { LiveSuggestionsPanel } from "@/components/LiveSuggestionsPanel";
import { ChatPanel, chatEventBus } from "@/components/ChatPanel";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { useSessionOrchestrator } from "@/lib/useSessionOrchestrator";
import { useSessionStore } from "@/lib/sessionStore";
import type { SuggestionCard } from "@/lib/types";

export default function Home() {
  const orchestrator = useSessionOrchestrator();
  const {
    error,
    settingsHydrated,
    hasApiKey,
    setError,
    openSettings,
    markCardUsed,
    hydrateSettings,
  } = useSessionStore(
    useShallow((s) => ({
      error: s.error,
      settingsHydrated: s.settingsHydrated,
      hasApiKey: !!s.settings.apiKey,
      setError: s.setError,
      openSettings: s.openSettings,
      markCardUsed: s.markCardUsed,
      hydrateSettings: s.hydrateSettings,
    })),
  );

  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    if (settingsHydrated && !hasApiKey) {
      openSettings();
    }
  }, [settingsHydrated, hasApiKey, openSettings]);

  const handleCardClick = (card: SuggestionCard, batchId: string) => {
    markCardUsed(batchId, card.id);
    chatEventBus.handler?.(card);
  };

  // Shortcuts for live demo. We only act on a bare keypress — any modifier
  // (ctrl/meta/alt) or typing context (input/textarea/contenteditable,
  // settings drawer open) disables them to avoid stealing the user's input.
  const orchestratorRef = useRef(orchestrator);
  orchestratorRef.current = orchestrator;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          active.isContentEditable
        ) {
          return;
        }
        // Don't steal Space/Enter from buttons (mic button, card controls,
        // etc.) — Space on a focused button already means "click the
        // button". Shortcut should only fire when focus is on body / a
        // non-interactive container.
        const role = active.getAttribute("role");
        if (tag === "BUTTON" || role === "button") {
          if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
            return;
          }
        }
      }
      if (useSessionStore.getState().settingsOpen) return;
      const key = e.key;
      // Space: toggle recording (or demo streaming).
      if (key === " " || key === "Spacebar") {
        e.preventDefault();
        const s = useSessionStore.getState();
        if (s.isRecording) {
          if (s.settings.demoMode) orchestratorRef.current.stopDemoMode();
          else orchestratorRef.current.stopRecording();
          useSessionStore.getState().setRecording(false);
        } else {
          if (s.settings.demoMode) {
            orchestratorRef.current.startDemoMode();
            useSessionStore.getState().setRecording(true);
          } else {
            void orchestratorRef.current.startRecording();
          }
        }
        return;
      }
      // R: refresh suggestions.
      if (key === "r" || key === "R") {
        e.preventDefault();
        void orchestratorRef.current.manualRefresh();
        return;
      }
      // C: focus the chat input.
      if (key === "c" || key === "C") {
        const el = document.getElementById("chat-input") as
          | HTMLTextAreaElement
          | null;
        if (el) {
          e.preventDefault();
          el.focus();
          try {
            const len = el.value.length;
            el.setSelectionRange(len, len);
          } catch {}
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <Header />

      {error && (
        <div className="flex items-start justify-between gap-3 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            onClick={() => setError(null)}
            className="shrink-0 rounded px-2 py-0.5 text-rose-200 hover:bg-rose-500/20"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
        <MicTranscriptPanel orchestrator={orchestrator} />
        <LiveSuggestionsPanel
          orchestrator={orchestrator}
          onCardClick={handleCardClick}
        />
        <ChatPanel />
      </div>

      <SettingsDrawer />
    </main>
  );
}
