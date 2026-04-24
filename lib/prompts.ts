import type { MeetingBrief, SuggestionPlan, SuggestionCard } from "./types";

export function formatBrief(brief: MeetingBrief | null): string {
  if (!brief) return "(no brief yet — meeting just started)";
  const lines: string[] = [];
  if (brief.topic) lines.push(`Topic: ${brief.topic}`);
  if (brief.goal) lines.push(`Goal: ${brief.goal}`);
  if (brief.participants.length)
    lines.push(`Participants: ${brief.participants.join(", ")}`);
  if (brief.openQuestions.length) {
    lines.push("Open questions:");
    for (const q of brief.openQuestions) lines.push(`  - ${q}`);
  }
  if (brief.keyFacts.length) {
    lines.push("Key facts:");
    for (const f of brief.keyFacts) lines.push(`  - ${f}`);
  }
  return lines.join("\n");
}

export function formatRecentPreviews(previews: string[]): string {
  if (!previews.length) return "(none yet)";
  return previews.map((p, i) => `${i + 1}. ${p}`).join("\n");
}

export function formatPlan(plan: SuggestionPlan): string {
  return plan.slots
    .map(
      (s, i) =>
        `${i + 1}. ${s.type} — rationale: ${s.rationale}`,
    )
    .join("\n");
}

export function buildPlannerUser(params: {
  transcriptTail: string;
  brief: MeetingBrief | null;
  recentPreviews: string[];
}): string {
  return [
    "RECENT TRANSCRIPT (last window, oldest first):",
    params.transcriptTail || "(transcript is empty so far)",
    "",
    "MEETING BRIEF:",
    formatBrief(params.brief),
    "",
    "LAST SHOWN CARD PREVIEWS (avoid repeating these ideas):",
    formatRecentPreviews(params.recentPreviews),
    "",
    "TASK: Decide the 3 most valuable suggestion slots for the NEXT batch based on the current moment. Output strict JSON per the system prompt schema.",
  ].join("\n");
}

export function buildGeneratorUser(params: {
  transcriptTail: string;
  brief: MeetingBrief | null;
  recentPreviews: string[];
  plan: SuggestionPlan;
}): string {
  return [
    "RECENT TRANSCRIPT (last window, oldest first):",
    params.transcriptTail || "(transcript is empty so far)",
    "",
    "MEETING BRIEF:",
    formatBrief(params.brief),
    "",
    "LAST SHOWN CARD PREVIEWS (do not repeat these):",
    formatRecentPreviews(params.recentPreviews),
    "",
    "PLAN (produce 3 cards in this exact order, matching types):",
    formatPlan(params.plan),
    "",
    "TASK: Emit the 3 cards per the system prompt schema. JSON only.",
  ].join("\n");
}

// Extract the actionable heuristic bullets from the planner system prompt so
// we can inline them into the generator user message as per-round guidance,
// without dragging the planner's (conflicting) output schema along with us.
function extractPlannerHeuristics(plannerPrompt: string): string {
  const lines = plannerPrompt.split("\n");
  const start = lines.findIndex((l) => /^Heuristics:\s*$/i.test(l.trim()));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) break;
    if (/^[A-Z]/.test(l.trim()) && !l.trim().startsWith("-")) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

// Single-call variant used by the live suggestions route. The model both
// picks the 3 slot types (applying the planner heuristics inlined below)
// and writes the cards in one pass. Cuts p50 latency ~50% vs the old
// planner→generator pipeline, and avoids the schema-conflict bug where the
// planner's `{slots}` output shape leaked into the generator's response.
export function buildSuggestionsUser(params: {
  transcriptTail: string;
  brief: MeetingBrief | null;
  recentPreviews: string[];
  plannerRules?: string;
  meetingStyle?: string;
  downvotedPreviews?: string[];
}): string {
  const heuristics = params.plannerRules
    ? extractPlannerHeuristics(params.plannerRules)
    : "";
  const blocks: string[] = [
    "RECENT TRANSCRIPT (last window, oldest first):",
    params.transcriptTail || "(transcript is empty so far)",
    "",
    "MEETING BRIEF:",
    formatBrief(params.brief),
    "",
    "LAST SHOWN CARD PREVIEWS (these ideas are stale — pick DIFFERENT angles):",
    formatRecentPreviews(params.recentPreviews),
  ];
  if (params.downvotedPreviews && params.downvotedPreviews.length > 0) {
    blocks.push(
      "",
      "USER DOWN-VOTED THESE RECENT CARDS (the user told us these were unhelpful — do NOT produce cards like them, try a genuinely different angle or card type):",
      formatRecentPreviews(params.downvotedPreviews),
    );
  }
  if (heuristics) {
    blocks.push("", "SLOT-PICKING RULES (choose 3 types for THIS moment):", heuristics);
  }
  if (params.meetingStyle && params.meetingStyle.trim().length > 0) {
    blocks.push(
      "",
      "MEETING-TYPE STYLE (bias slot choice AND card tone for this kind of meeting, but NEVER contradict the transcript):",
      params.meetingStyle.trim(),
    );
  }
  blocks.push(
    "",
    "TASK: Pick the 3 most valuable suggestion TYPES for RIGHT NOW based on the transcript and the rules, then write one concrete card per type. Each card's preview must be grounded in something that was just said or written in the brief — do NOT emit generic filler like \"What's the single biggest risk?\" or \"Summarize the core decision.\".",
    'Output STRICT JSON exactly: {"cards":[{"type","preview","expanded_seed","confidence","rationale"},{"..."},{"..."}]}.',
    "No prose. No other top-level keys. Exactly 3 cards.",
  );
  return blocks.join("\n");
}

export function buildBriefUser(params: {
  previousBrief: MeetingBrief | null;
  transcriptWindow: string;
}): string {
  return [
    "PREVIOUS BRIEF (JSON):",
    params.previousBrief
      ? JSON.stringify(
          {
            topic: params.previousBrief.topic,
            goal: params.previousBrief.goal,
            participants: params.previousBrief.participants,
            open_questions: params.previousBrief.openQuestions,
            key_facts: params.previousBrief.keyFacts,
          },
          null,
          2,
        )
      : "{}",
    "",
    "RECENT TRANSCRIPT WINDOW:",
    params.transcriptWindow || "(empty)",
    "",
    "TASK: Return an updated brief JSON per the system prompt schema.",
  ].join("\n");
}

export function buildChatUserForCard(params: {
  brief: MeetingBrief | null;
  transcriptTail: string;
  card: SuggestionCard;
}): string {
  return [
    "MEETING BRIEF:",
    formatBrief(params.brief),
    "",
    "RECENT TRANSCRIPT:",
    params.transcriptTail || "(empty)",
    "",
    `The user clicked a suggestion card of type "${params.card.type}". Expand it with concrete depth.`,
    `Card preview: ${params.card.preview}`,
    `Expansion seed: ${params.card.expandedSeed}`,
    "",
    "Please respond to the expansion seed above, grounded in the transcript where possible.",
  ].join("\n");
}

export function buildChatUserForFreeform(params: {
  brief: MeetingBrief | null;
  transcriptTail: string;
  message: string;
}): string {
  return [
    "MEETING BRIEF:",
    formatBrief(params.brief),
    "",
    "RECENT TRANSCRIPT:",
    params.transcriptTail || "(empty)",
    "",
    "User's question:",
    params.message,
  ].join("\n");
}

export function buildFallbackCards(
  brief: MeetingBrief | null,
): Array<Omit<SuggestionCard, "id">> {
  const topic = brief?.topic || "the current meeting topic";
  return [
    {
      type: "question_to_ask",
      preview: `What's the single biggest risk right now in ${topic}?`,
      expandedSeed: `Help me think through the biggest risks in ${topic} and what I should ask next.`,
      confidence: 0.3,
      rationale: "fallback: generic driver question when context is thin",
    },
    {
      type: "clarifying_info",
      preview: `Summarize the core decision being discussed in 2 bullets so I can follow along.`,
      expandedSeed: `Summarize the core decision being discussed and the key tradeoffs.`,
      confidence: 0.3,
      rationale: "fallback: orient user when context is thin",
    },
    {
      type: "talking_point",
      preview: `A useful angle: tie the discussion to a concrete success metric or constraint.`,
      expandedSeed: `What concrete success metric or constraint could I bring up to focus this discussion?`,
      confidence: 0.3,
      rationale: "fallback: surface angle when context is thin",
    },
  ];
}
