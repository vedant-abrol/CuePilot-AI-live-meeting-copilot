"use client";

import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/lib/sessionStore";
import { buildExport, exportToText } from "@/lib/exportSession";

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportButton() {
  const state = useSessionStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      transcript: s.transcript,
      briefHistory: s.briefHistory,
      batches: s.batches,
      chat: s.chat,
      settings: s.settings,
    })),
  );

  const onExport = () => {
    const payload = buildExport(state);
    const base = `twinmind-session-${new Date(state.startedAt)
      .toISOString()
      .replace(/[:.]/g, "-")}`;
    download(`${base}.json`, JSON.stringify(payload, null, 2), "application/json");
    download(`${base}.txt`, exportToText(payload), "text/plain");
  };

  return (
    <button
      onClick={onExport}
      className="rounded-md border border-bg-border bg-bg-raised px-3 py-1.5 text-xs font-medium text-text hover:bg-bg-border"
      title="Download session: transcript + batches + chat (JSON and text)"
    >
      Export
    </button>
  );
}
