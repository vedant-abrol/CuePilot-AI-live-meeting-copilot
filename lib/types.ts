export type SuggestionType =
  | "question_to_ask"
  | "talking_point"
  | "answer"
  | "fact_check"
  | "clarifying_info";

export type MeetingType =
  | "general"
  | "standup"
  | "interview"
  | "sales_call"
  | "one_on_one"
  | "design_review"
  | "customer_discovery";

export interface TranscriptChunk {
  id: string;
  t: number;
  durationMs: number;
  text: string;
  source: "mic" | "demo";
}

export type CardRating = "up" | "down";

export interface SuggestionCard {
  id: string;
  type: SuggestionType;
  preview: string;
  expandedSeed: string;
  confidence: number;
  rationale?: string;
  used?: boolean;
  rating?: CardRating;
  pinned?: boolean;
}

export interface SuggestionBatch {
  id: string;
  t: number;
  cards: SuggestionCard[];
  plannerNote?: string;
  latencyMs?: number;
}

export interface MeetingBrief {
  t: number;
  topic: string;
  goal: string;
  participants: string[];
  openQuestions: string[];
  keyFacts: string[];
  updatedFromChunkIds: string[];
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  t: number;
  role: ChatRole;
  content: string;
  streaming?: boolean;
  triggeredByCardId?: string;
  firstTokenMs?: number;
  totalMs?: number;
}

export interface Settings {
  apiKey: string;
  autoRefresh: boolean;
  demoMode: boolean;
  transcriptionModel: string;
  suggestionModel: string;
  chatModel: string;
  plannerSystemPrompt: string;
  generatorSystemPrompt: string;
  briefSystemPrompt: string;
  chatSystemPrompt: string;
  suggestionContextChars: number;
  chatContextChars: number;
  briefContextChars: number;
  chunkSeconds: number;
  briefEveryNChunks: number;
  meetingType: MeetingType;
}

export interface PlanSlot {
  type: SuggestionType;
  rationale: string;
}

export interface SuggestionPlan {
  slots: PlanSlot[];
  note: string;
}
