import type { AgentContext } from "./digital-employees.ts";

export const KNOWLEDGE_CATEGORIES = [
  "business_rule",
  "platform_policy",
  "product",
  "supplier",
  "operations",
  "content",
  "case",
  "glossary",
] as const;

export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number];
export type IntelligenceScope = "global" | AgentContext;

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  scope: IntelligenceScope;
  source: string;
  tags: string[];
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRule {
  id: string;
  name: string;
  instruction: string;
  scope: IntelligenceScope;
  enabled: boolean;
  priority: number;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeMatch {
  entry: KnowledgeEntry;
  score: number;
}

export interface IntelligenceOverview {
  knowledge: KnowledgeEntry[];
  promptRules: PromptRule[];
  stats: {
    knowledgeCount: number;
    enabledKnowledgeCount: number;
    promptRuleCount: number;
    enabledPromptRuleCount: number;
  };
}

const WEB_SEARCH_TOPICS = ["general", "news"] as const;
const WEB_SEARCH_TIME_RANGES = ["day", "week", "month", "year"] as const;

export type WebSearchTopic = typeof WEB_SEARCH_TOPICS[number];
export type WebSearchTimeRange = typeof WEB_SEARCH_TIME_RANGES[number];

export interface WebSearchInput {
  query: string;
  topic?: WebSearchTopic;
  timeRange?: WebSearchTimeRange;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  source: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  searchedAt: string;
  results: WebSearchResult[];
}
