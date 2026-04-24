# TwinMind — Live Suggestions

An AI meeting copilot web app. Listens to your mic, transcribes live, and surfaces **3 contextually useful suggestions** (question to ask, talking point, answer, fact-check, or clarifying info) every ~30 seconds. Click any suggestion to stream a detailed answer in a chat on the right. Export the full session with timestamps at any time.

Built for the TwinMind Live Suggestions assignment.

## Stack

- Next.js 14 (App Router) + React 18 + TypeScript
- Tailwind CSS
- Zustand for session state
- Zod for structured output validation
- Groq APIs:
  - `whisper-large-v3` for transcription
  - `openai/gpt-oss-120b` for suggestions, meeting brief, and chat

## Setup

Requirements: Node 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000, paste your Groq API key in Settings (click `Add API key` in the header), and start recording.

The API key is stored **only in your browser's localStorage** and forwarded per request to the app's Next.js API routes, which relay to Groq. It is never persisted on a server.

## Architecture

```
Browser MediaRecorder ── 30s chunks ──► /api/transcribe ──► Groq Whisper v3
                                                      │
                                            transcript store
                                                      │
                       ┌──────────────────────────────┼──────────────────────────┐
                       ▼                              ▼                          ▼
              /api/brief (every N chunks)     /api/suggestions             /api/chat (Edge, SSE)
              MomentBrief updater             Single-call cards gen        Streaming detailed answers
                 (gpt-oss-120b)                (gpt-oss-120b, JSON mode,    (gpt-oss-120b, streamed)
                                                Zod-validated + repair +
                                                Jaccard dedupe retry)
```

### Suggestion pipeline

On each new transcript chunk (and on the manual refresh button) we call `/api/suggestions`, which runs a **single JSON-mode chat completion** that:

1. Reads the recent transcript window + the rolling meeting brief + the last ~6 card previews shown to the user.
2. Picks the 3 most valuable slot types for RIGHT NOW (from the fixed taxonomy below), using heuristic rules inlined from the planner system prompt.
3. Emits one concrete card per slot, with `type`, `preview`, `expanded_seed`, `confidence`, and `rationale`.

Slot taxonomy (5 types):

- `question_to_ask` — a sharp question to move the conversation forward.
- `talking_point` — a concrete angle/example the user could contribute.
- `answer` — a direct answer to a question just asked on the call.
- `fact_check` — a specific recent claim worth verifying.
- `clarifying_info` — a definition/expansion of jargon or an acronym that just came up.

Why single-call instead of planner→generator? Groq's free tier occasionally spikes per-call latency to 10–20s. Two sequential JSON calls made the refresh unusable in long meetings. Inlining the planner heuristics into the generator's user message gave us the same "right mix at the right time" behavior at half the latency.

The response is **Zod-validated**, then passed through:

- A **shape coercer** (GPT-OSS sometimes wraps the cards under `{batch: {cards:…}}`, `{suggestions:…}`, a bare array, etc. — all normalized to `{cards: […]}`).
- A **per-card repairer** (tolerates snake_case/camelCase field drift, fuzzy type names, string confidences).
- A **schema-miss repair retry** with a strict "re-emit only the top-level JSON object" instruction if the first output still fails.
- A **normalized-Jaccard dedupe retry** against the last ~6 previews (threshold 0.55). If any card overlaps too closely with a recent one, we retry once with an explicit "avoid these exact previews" list. If the fresh batch reduces overlap, we use it; otherwise we keep the original.
- A final **safe fallback** built from the brief (3 generic-but-non-harmful cards) if the model still misbehaves — this is surfaced in the UI as a `FALLBACK` tag on the batch so you can see when it happens.

The 3 cards are guaranteed; the worst case is the fallback batch, not an empty UI.

### Rolling meeting brief

A small JSON object `{topic, goal, participants, open_questions, key_facts}` maintained by `/api/brief`. Updated on the first chunk and then every N chunks (configurable in Settings, default 3). Injected into the suggestion and chat prompts so cards stay anchored to the actual topic over long meetings, and survive the transcript window sliding past the early-meeting context (who's there, what they're trying to decide).

### Streaming chat

`/api/chat` runs on the **Edge runtime** and streams Server-Sent Events so the first token appears in the UI as soon as Groq emits it. Click a suggestion card: it is appended as a user message, and we stream the detailed answer using the clicked card's `expanded_seed` plus the recent transcript tail, the current brief, and the chat history. You can also type freeform questions — same endpoint, no card field.

### Transcription

Browser `MediaRecorder` on `audio/webm;codecs=opus` with a 30-second timeslice (configurable). Each slice is POSTed to `/api/transcribe`, which forwards the blob to Groq Whisper Large V3. We pass the tail of the previous transcript as Whisper's `prompt` argument for continuity across chunk boundaries.

Whisper hallucinations are a known problem on silent or noisy chunks ("Thank you.", "Thanks for watching.", repeated single words). We suppress them in three ways:

1. **Client-side silence gate** — an AnalyserNode RMS check on the live mic stream. If the peak RMS of a 30s slice is below ~0.015 (empirical floor that sits above room noise but well below normal speech), we skip the upload entirely.
2. **Per-segment filter** — we request `verbose_json` and drop segments with `no_speech_prob > 0.6`, `avg_logprob < -1.0`, or `compression_ratio > 2.4`.
3. **Phrase + repetition filter** — a stop-list for known hallucination phrases (only when they're the entire output), plus a bigram-repetition detector that catches "word word word word" loops.

Manual refresh flushes the current in-flight slice via `MediaRecorder.requestData()`, transcribes it, then re-runs the suggestion pipeline.

## Prompt strategy & tradeoffs

**Grounding.** The generator system prompt is explicit that previews must reference something specific from the transcript or brief. Schema examples are concrete (with realistic values) to avoid the common GPT-OSS failure mode where it copies literal `"..."` placeholders into its output.

**Preview carries the payload.** The preview alone must deliver value — the click expansion adds depth, it does not reveal something hidden. The generator prompt spells this out per type (e.g. for `answer`, the preview is a direct 2-sentence answer; clicking expands with examples/tradeoffs).

**Fact-check safety.** GPT-OSS can hallucinate specific numbers/dates. The generator prompt instructs it to frame fact-checks as "worth verifying: …" unless highly confident, and to never fabricate specific numbers, names, or dates. This keeps the tool trustworthy during a real conversation.

**Chat length budget.** The chat system prompt enforces ~80–160 words, plain prose, at most one short bullet list, no markdown tables / horizontal rules / headings. This is a deliberate choice for a mid-call assistant — a 500-word answer is useless when the conversation is already on the next topic.

**Tradeoffs:**

- *Suggestion latency vs freshness.* Dedupe-retry adds at most one extra JSON call when the model recycles a preview. On a free Groq tier a single extra call can cost ~2–4s; in practice it fires on <20% of batches.
- *Single-call vs two-stage pipeline.* Two-stage (planner → generator) gave marginally better type mix on ambiguous moments but doubled worst-case latency. I chose responsiveness.
- *No persistence.* Session state is in-memory per browser tab. A reload clears everything (matches the spec).
- *Mic only.* We capture the user's microphone, not system audio, since system audio requires OS-level loopback. For real use, pairing with a meeting tool's bot or a system-audio capture extension is the obvious next step.

## Settings

Click `Settings` (or `Add API key`) in the header.

- **API key** — Groq key, masked, stored in localStorage only.
- **Meeting type** — picks a style paragraph (standup / interview / sales call / 1:1 / design review / customer discovery / general) that gets injected into the suggestion-generator user prompt. It nudges both slot selection and card tone for this kind of meeting without overriding the transcript-grounded heuristics.
- **Auto refresh** — when on, suggestions re-run on every new transcript chunk.
- **Demo mode** — streams a canned engineering-meeting transcript instead of using the mic, useful for evaluating prompts without speaking.
- **Models** — editable slugs for transcription, suggestions, chat.
- **Chunk seconds** — transcript slice size (default 30s, range 10–120).
- **Prompts** — full editable system prompts for the moment planner (its heuristics are inlined into the generator call), suggestion generator, brief updater, and chat, each with a "restore default" button.
- **Context windows** — chars for the suggestion tail, chat tail, and brief tail; and how often to update the brief.

All defaults are hardcoded in `lib/defaultSettings.ts` with the values I found to work best during development.

## Polish / feedback loop

- **Why this card?** — each card has a small `i` button that reveals the model's `rationale` field (already in the schema, previously hidden).
- **Thumbs up / down** — per-card. Downvoted cards are added to a visible `USER DOWN-VOTED THESE RECENT CARDS` block on the next batch's prompt, so the feedback loop is explicit on the next refresh.
- **Pin card** — pinned cards show in a sticky band at the top of the Live Suggestions feed. Useful for a fact-check you want to bring up a few seconds later.
- **Audio level meter** — when recording, a VU-style bar next to the mic button reads the same `AnalyserNode` we use for the silence gate, so you can see at a glance whether the app is hearing you (and whether the current slice is below the silence threshold that would cause it to be skipped).
- **Chat message actions** — copy, copy-as-quote (wraps with `> `), and a re-ask button that drops the text back into the input so you can tweak phrasing before resending.
- **Keyboard shortcuts** — `Space` toggles recording, `R` refreshes suggestions, `C` focuses the chat input. Shortcuts are suppressed while typing in a field or while a button is focused so they never steal keys.
- **Groq health pill** — the header pings `GET /api/health` (which hits Groq's `/models` endpoint with your key) every 60s and on tab refocus, and shows `Groq: ok · Xms` or a red `rate-limited` / `bad key` / `down` status. Click the pill to re-check immediately.

## Export

The `Export` button (top-right) downloads the full session as **both** a JSON and a plain-text file, named by session timestamp. Includes:

- Transcript chunks with timestamps.
- Meeting brief snapshots over time.
- Every suggestion batch (cards + types + previews + expansion seeds + whether each card was clicked) with timestamps.
- Full chat history with timestamps and per-message streaming latencies.
- A snapshot of the active settings (API key redacted).

## Latency targets (measured in-app and shown in header)

- **Suggestion refresh → batch rendered:** ~1–3s on short context tails, ~3–6s on long ones (free Groq tier, incl. dedupe retry when it fires).
- **Chat send → first token:** <500ms on Edge with streaming for short prompts.

The header shows the most recent measured values as `sugg: …ms` and `chat: …ms`.

## Project layout

- `app/` — Next.js App Router: `page.tsx`, `layout.tsx`, API routes under `app/api/{transcribe,suggestions,brief,chat}/route.ts`.
- `components/` — UI components, one per concern.
- `lib/` — domain types, settings, session store (zustand), Groq client, prompt builders, schemas, dedupe, recorder hook, orchestrator hook, demo transcript, export.

## Known limitations

- Mic capture only — no system-audio mixing out of the box.
- Edge route uses the Web Fetch streaming API; behavior on some older browsers may differ.
- Brief updates are JSON-only; no streaming, so a slow brief call does not block suggestions (it runs in parallel and merges on completion).
- No tests shipped — this is an MVP under a tight timeline.

## License

MIT for code written here. Groq terms apply to API usage.
