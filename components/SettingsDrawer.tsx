"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/lib/sessionStore";
import {
  DEFAULT_SETTINGS,
  MEETING_TYPES,
  getMeetingTypeOption,
} from "@/lib/defaultSettings";
import type { MeetingType } from "@/lib/types";

type Tab = "key" | "prompts" | "windows";

export function SettingsDrawer() {
  const {
    settingsOpen,
    closeSettings,
    settings,
    updateSettings,
    resetSettings,
  } = useSessionStore(
    useShallow((s) => ({
      settingsOpen: s.settingsOpen,
      closeSettings: s.closeSettings,
      settings: s.settings,
      updateSettings: s.updateSettings,
      resetSettings: s.resetSettings,
    })),
  );
  const [tab, setTab] = useState<Tab>("key");
  const [revealKey, setRevealKey] = useState(false);

  useEffect(() => {
    if (!settingsOpen) setTab("key");
  }, [settingsOpen]);

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/60 backdrop-blur-sm"
        onClick={closeSettings}
      />
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-bg-border bg-bg-panel">
        <header className="flex items-center justify-between border-b border-bg-border px-5 py-3">
          <div>
            <div className="text-sm font-semibold">Settings</div>
            <div className="text-xs text-text-dim">
              API key is stored only in this browser. Prompts and windows
              customize the live pipeline.
            </div>
          </div>
          <button
            onClick={closeSettings}
            className="rounded-md border border-bg-border px-3 py-1.5 text-xs hover:bg-bg-raised"
          >
            Close
          </button>
        </header>

        <nav className="flex gap-1 border-b border-bg-border bg-bg-soft px-3 py-2 text-xs">
          {(
            [
              ["key", "API key & toggles"],
              ["prompts", "Prompts"],
              ["windows", "Context windows"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                "rounded px-3 py-1.5",
                tab === id
                  ? "bg-bg-raised text-text"
                  : "text-text-muted hover:bg-bg-raised",
              )}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto">
            <button
              onClick={() => {
                if (
                  confirm(
                    "Reset all prompts and context windows to defaults? Your API key is kept.",
                  )
                ) {
                  const current = useSessionStore.getState().settings.apiKey;
                  resetSettings();
                  useSessionStore
                    .getState()
                    .updateSettings({ apiKey: current });
                }
              }}
              className="rounded px-3 py-1.5 text-text-dim hover:bg-bg-raised"
            >
              Reset to defaults
            </button>
          </div>
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {tab === "key" && (
            <div className="space-y-6">
              <Field
                label="Groq API key"
                hint="Get one at console.groq.com. Stored in localStorage only; sent per request to our API routes which forward to Groq."
              >
                <div className="flex items-stretch gap-2">
                  <input
                    type={revealKey ? "text" : "password"}
                    value={settings.apiKey}
                    onChange={(e) => updateSettings({ apiKey: e.target.value })}
                    placeholder="gsk_…"
                    className="flex-1 rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm outline-none focus:border-accent/60"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealKey((v) => !v)}
                    className="rounded-md border border-bg-border px-3 text-xs hover:bg-bg-raised"
                  >
                    {revealKey ? "hide" : "show"}
                  </button>
                </div>
              </Field>

              <Field
                label="Meeting type"
                hint="Nudges the suggestion generator to bias card types and tone for this kind of conversation. Updates apply on the next batch."
              >
                <MeetingTypeSelector
                  value={settings.meetingType}
                  onChange={(v) => updateSettings({ meetingType: v })}
                />
              </Field>

              <Field label="Auto refresh suggestions (~every chunk)">
                <Toggle
                  value={settings.autoRefresh}
                  onChange={(v) => updateSettings({ autoRefresh: v })}
                />
              </Field>

              <Field
                label="Demo mode"
                hint="Streams a canned meeting transcript instead of using the mic. Useful for evaluating prompts without speaking."
              >
                <Toggle
                  value={settings.demoMode}
                  onChange={(v) => updateSettings({ demoMode: v })}
                />
              </Field>

              <Field label="Models">
                <div className="grid grid-cols-2 gap-3">
                  <ModelField
                    label="Transcription"
                    value={settings.transcriptionModel}
                    onChange={(v) =>
                      updateSettings({ transcriptionModel: v })
                    }
                  />
                  <ModelField
                    label="Suggestions"
                    value={settings.suggestionModel}
                    onChange={(v) => updateSettings({ suggestionModel: v })}
                  />
                  <ModelField
                    label="Chat"
                    value={settings.chatModel}
                    onChange={(v) => updateSettings({ chatModel: v })}
                  />
                  <Field label="Chunk seconds">
                    <input
                      type="number"
                      min={10}
                      max={120}
                      value={settings.chunkSeconds}
                      onChange={(e) =>
                        updateSettings({
                          chunkSeconds: Math.max(
                            10,
                            Math.min(120, Number(e.target.value) || 30),
                          ),
                        })
                      }
                      className="w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm"
                    />
                  </Field>
                </div>
              </Field>
            </div>
          )}

          {tab === "prompts" && (
            <div className="space-y-5">
              <PromptField
                label="Moment planner (system)"
                hint="Heuristic rules here are inlined into each suggestion request (single-pass generation). Edit to tune slot choice and mix."
                value={settings.plannerSystemPrompt}
                defaultValue={DEFAULT_SETTINGS.plannerSystemPrompt}
                onChange={(v) => updateSettings({ plannerSystemPrompt: v })}
              />
              <PromptField
                label="Suggestion generator (system)"
                hint="Produces the 3 cards from the plan + context."
                value={settings.generatorSystemPrompt}
                defaultValue={DEFAULT_SETTINGS.generatorSystemPrompt}
                onChange={(v) =>
                  updateSettings({ generatorSystemPrompt: v })
                }
              />
              <PromptField
                label="Meeting brief updater (system)"
                hint="Maintains the rolling meeting brief."
                value={settings.briefSystemPrompt}
                defaultValue={DEFAULT_SETTINGS.briefSystemPrompt}
                onChange={(v) => updateSettings({ briefSystemPrompt: v })}
              />
              <PromptField
                label="Chat (system)"
                hint="Used for detailed answers on click and freeform chat."
                value={settings.chatSystemPrompt}
                defaultValue={DEFAULT_SETTINGS.chatSystemPrompt}
                onChange={(v) => updateSettings({ chatSystemPrompt: v })}
              />
            </div>
          )}

          {tab === "windows" && (
            <div className="space-y-4">
              <NumField
                label="Suggestion transcript window (chars)"
                hint="How much recent transcript feeds the planner + generator."
                value={settings.suggestionContextChars}
                onChange={(v) =>
                  updateSettings({ suggestionContextChars: v })
                }
                min={500}
                max={20000}
                step={500}
              />
              <NumField
                label="Chat transcript window (chars)"
                hint="How much transcript feeds detailed chat answers."
                value={settings.chatContextChars}
                onChange={(v) => updateSettings({ chatContextChars: v })}
                min={500}
                max={40000}
                step={500}
              />
              <NumField
                label="Brief transcript window (chars)"
                hint="How much transcript the brief updater sees each pass."
                value={settings.briefContextChars}
                onChange={(v) => updateSettings({ briefContextChars: v })}
                min={500}
                max={20000}
                step={500}
              />
              <NumField
                label="Update brief every N chunks"
                value={settings.briefEveryNChunks}
                onChange={(v) => updateSettings({ briefEveryNChunks: v })}
                min={1}
                max={10}
                step={1}
              />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-text">{label}</div>
      {hint && <div className="mb-2 text-[11px] text-text-dim">{hint}</div>}
      {children}
    </label>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={clsx(
        "relative h-6 w-11 rounded-full border transition",
        value
          ? "border-accent/60 bg-accent/70"
          : "border-bg-border bg-bg-raised",
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition",
          value ? "left-[22px]" : "left-1",
        )}
      />
    </button>
  );
}

function ModelField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-text-muted">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm"
      />
    </div>
  );
}

function NumField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n))
            onChange(Math.max(min, Math.min(max, Math.round(n))));
        }}
        className="w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm"
      />
    </Field>
  );
}

function MeetingTypeSelector({
  value,
  onChange,
}: {
  value: MeetingType;
  onChange: (v: MeetingType) => void;
}) {
  const current = getMeetingTypeOption(value);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {MEETING_TYPES.map((m) => (
          <button
            type="button"
            key={m.id}
            onClick={() => onChange(m.id)}
            className={clsx(
              "rounded-md border px-2.5 py-1 text-[11px] transition",
              value === m.id
                ? "border-accent/60 bg-accent/15 text-accent"
                : "border-bg-border bg-bg-raised text-text-muted hover:text-text",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      <pre className="mt-2 whitespace-pre-wrap rounded-md border border-bg-border bg-bg/50 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-text-muted">
        {current.style}
      </pre>
    </div>
  );
}

function PromptField({
  label,
  hint,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  defaultValue: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full resize-y rounded-md border border-bg-border bg-bg-raised px-3 py-2 font-mono text-xs leading-relaxed"
      />
      <div className="mt-1 text-right">
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          className="text-[10px] text-text-dim hover:text-text"
        >
          restore default
        </button>
      </div>
    </Field>
  );
}
