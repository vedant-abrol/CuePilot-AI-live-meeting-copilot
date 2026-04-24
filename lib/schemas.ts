import { z } from "zod";

export const SuggestionTypeSchema = z.enum([
  "question_to_ask",
  "talking_point",
  "answer",
  "fact_check",
  "clarifying_info",
]);

export const PlanSlotSchema = z.object({
  type: SuggestionTypeSchema,
  rationale: z.string().min(1).max(300),
});

export const SuggestionPlanSchema = z.object({
  slots: z.array(PlanSlotSchema).length(3),
  note: z.string().max(400).default(""),
});

export const SuggestionCardRawSchema = z.object({
  type: SuggestionTypeSchema,
  preview: z.string().min(3).max(500),
  expanded_seed: z.string().min(3).max(600),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400).optional().default(""),
});

// Looser shape: accept 3–6 cards and we'll slice to the first 3 in the
// route. GPT-OSS-120B sometimes emits 4 or 5 cards despite instructions.
export const SuggestionBatchRawSchema = z.object({
  cards: z.array(SuggestionCardRawSchema).min(3).max(6),
});

export const MeetingBriefSchema = z.object({
  topic: z.string().max(240).default(""),
  goal: z.string().max(240).default(""),
  participants: z.array(z.string().max(80)).max(10).default([]),
  open_questions: z.array(z.string().max(240)).max(8).default([]),
  key_facts: z.array(z.string().max(240)).max(10).default([]),
});

export type SuggestionPlanRaw = z.infer<typeof SuggestionPlanSchema>;
export type SuggestionCardRaw = z.infer<typeof SuggestionCardRawSchema>;
export type SuggestionBatchRaw = z.infer<typeof SuggestionBatchRawSchema>;
export type MeetingBriefRaw = z.infer<typeof MeetingBriefSchema>;
