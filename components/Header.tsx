"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/lib/sessionStore";
import { ExportButton } from "./ExportButton";

type HealthStatus =
  | "unknown"
  | "ok"
  | "no_key"
  | "bad_key"
  | "rate_limited"
  | "down"
  | "unreachable";

interface HealthState {
  status: HealthStatus;
  latencyMs: number | null;
  checkedAt: number | null;
}

export function Header() {
  const {
    settingsHydrated,
    hasApiKey,
    apiKey,
    openSettings,
    lastSuggestionLatencyMs,
    lastFirstTokenMs,
  } = useSessionStore(
    useShallow((s) => ({
      settingsHydrated: s.settingsHydrated,
      hasApiKey: !!s.settings.apiKey,
      apiKey: s.settings.apiKey,
      openSettings: s.openSettings,
      lastSuggestionLatencyMs: s.lastSuggestionLatencyMs,
      lastFirstTokenMs: s.lastFirstTokenMs,
    })),
  );
  // Until client settings have rehydrated from localStorage, render the
  // same markup the server produced to avoid a hydration mismatch.
  const hasKey = settingsHydrated ? hasApiKey : false;
  const buttonLabel = settingsHydrated ? (hasKey ? "Settings" : "Add API key") : "Settings";
  return (
    <header className="flex items-center justify-between border-b border-bg-border bg-bg-soft px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-accent/20 text-accent text-xs font-semibold">
          TM
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">
            TwinMind — Live Suggestions
          </div>
          <div className="text-xs text-text-dim">
            Transcript · 3 live suggestions · Streaming chat
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-text-dim">
        {settingsHydrated && hasKey && <HealthIndicator apiKey={apiKey} />}
        {lastSuggestionLatencyMs != null && (
          <span title="Last suggestion refresh latency">
            sugg: {lastSuggestionLatencyMs} ms
          </span>
        )}
        {lastFirstTokenMs != null && (
          <span title="Last chat first-token latency">
            chat: {lastFirstTokenMs} ms
          </span>
        )}
        <button
          onClick={openSettings}
          suppressHydrationWarning
          className={
            "rounded-md border px-3 py-1.5 text-xs font-medium transition " +
            (!settingsHydrated || hasKey
              ? "border-bg-border text-text hover:bg-bg-raised"
              : "border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20")
          }
        >
          {buttonLabel}
        </button>
        <ExportButton />
      </div>
    </header>
  );
}

function HealthIndicator({ apiKey }: { apiKey: string }) {
  const [state, setState] = useState<HealthState>({
    status: "unknown",
    latencyMs: null,
    checkedAt: null,
  });
  const inFlightRef = useRef<AbortController | null>(null);

  const check = async () => {
    if (!apiKey) return;
    // Cancel any outstanding probe so tab-wake doesn't stack requests.
    inFlightRef.current?.abort();
    const ctrl = new AbortController();
    inFlightRef.current = ctrl;
    try {
      const res = await fetch("/api/health", {
        headers: { "x-groq-key": apiKey },
        cache: "no-store",
        signal: ctrl.signal,
      });
      const json = (await res.json()) as {
        ok: boolean;
        status: HealthStatus;
        latencyMs: number | null;
      };
      setState({
        status: json.status,
        latencyMs: json.latencyMs,
        checkedAt: Date.now(),
      });
    } catch {
      if (!ctrl.signal.aborted) {
        setState({
          status: "unreachable",
          latencyMs: null,
          checkedAt: Date.now(),
        });
      }
    } finally {
      if (inFlightRef.current === ctrl) inFlightRef.current = null;
    }
  };

  useEffect(() => {
    if (!apiKey) return;
    void check();
    // Re-check every 60s and on tab refocus. Cheap — hits Groq /models.
    const id = window.setInterval(() => void check(), 60_000);
    const onFocus = () => {
      if (
        !state.checkedAt ||
        Date.now() - (state.checkedAt ?? 0) > 20_000
      ) {
        void check();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      inFlightRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const meta = statusMeta(state.status);
  const tooltip = (() => {
    if (state.status === "ok" && state.latencyMs != null)
      return `Groq reachable · ${state.latencyMs}ms round-trip. Checked ${fmtAgo(state.checkedAt)}. Click to re-check.`;
    if (state.status === "rate_limited")
      return `Groq responded with 429 rate-limited. Your key works, but suggestions/chat calls will be retried with backoff. Click to re-check.`;
    if (state.status === "bad_key")
      return `Groq rejected the API key (401/403). Fix it in Settings. Click to re-check.`;
    if (state.status === "down")
      return `Groq returned a server error. Suggestions may fail to generate. Click to re-check.`;
    if (state.status === "unreachable")
      return `Could not reach Groq from this browser/server. Check your network. Click to re-check.`;
    if (state.status === "no_key") return "No API key set.";
    return "Checking Groq…";
  })();

  return (
    <button
      type="button"
      onClick={() => void check()}
      title={tooltip}
      className={clsx(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-medium transition",
        meta.className,
      )}
    >
      <span
        className={clsx("h-1.5 w-1.5 rounded-full", meta.dot)}
        aria-hidden="true"
      />
      <span>{meta.label}</span>
      {state.status === "ok" && state.latencyMs != null && (
        <span className="text-text-dim">{state.latencyMs}ms</span>
      )}
    </button>
  );
}

function statusMeta(status: HealthStatus): {
  label: string;
  dot: string;
  className: string;
} {
  switch (status) {
    case "ok":
      return {
        label: "Groq: ok",
        dot: "bg-emerald-400",
        className:
          "border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/10",
      };
    case "rate_limited":
      return {
        label: "Groq: rate-limited",
        dot: "bg-amber-400",
        className:
          "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
      };
    case "bad_key":
      return {
        label: "Groq: bad key",
        dot: "bg-rose-400",
        className:
          "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
      };
    case "down":
      return {
        label: "Groq: down",
        dot: "bg-rose-400",
        className:
          "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
      };
    case "unreachable":
      return {
        label: "Groq: unreachable",
        dot: "bg-rose-400",
        className:
          "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
      };
    case "no_key":
      return {
        label: "Groq: no key",
        dot: "bg-text-dim",
        className: "border-bg-border text-text-dim",
      };
    default:
      return {
        label: "Groq: …",
        dot: "bg-text-dim",
        className: "border-bg-border text-text-dim",
      };
  }
}

function fmtAgo(t: number | null): string {
  if (!t) return "—";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  return `${min}m ago`;
}
