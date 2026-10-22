import type {
  ActionResponse,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  DashboardSnapshot,
  BusinessWorkflowRun,
  FlashSaleWorkflowRun,
  KolCreator,
  KolOutreachWorkflowRun,
  KolStats,
  ProductPublishWorkflowRun,
  TikTokCapabilitiesResponse,
  SkillsCatalogResponse,
  SkillStatus,
  SkillConnectionTestResult,
  TikTokBindingSummary,
  TikTokConnectionStatus,
  LlmProviderSummary,
  LlmProvidersOverview,
  LlmProviderTestResult,
  WorkflowListResponse,
  WorkflowHistoryItem,
  OfficeSnapshot,
} from "../shared/contracts";
import type { ContentAsset, ContentOverview, ContentTask } from "../shared/content";
import type { IntelligenceOverview, IntelligenceScope, KnowledgeCategory, KnowledgeEntry, KnowledgeMatch, PromptRule, WebSearchInput, WebSearchResponse } from "../shared/intelligence";

export type { TikTokBindingSummary, TikTokConnectionStatus, LlmProviderSummary, LlmProvidersOverview, LlmProviderTestResult } from "../shared/contracts";

export interface HealthResponse {
  ok: boolean;
  mode: "demo" | "connected" | "setup";
  connections: { llm: boolean; tiktok: boolean; miaoshou: boolean; tmapi: boolean; kolBridge: boolean };
  tiktok: TikTokConnectionStatus;
  llm: { connected: boolean; source: "provider" | "env" | "missing"; name?: string; model?: string };
  miaoshou: { connected: boolean };
  tmapi: { connected: boolean };
}

export interface KolOverviewResponse {
  status: { connected: boolean; port: number };
  creators: KolCreator[];
  stats: KolStats | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: Record<string, unknown> & { error?: string };
  try {
    body = JSON.parse(text) as Record<string, unknown> & { error?: string };
  } catch {
    console.error("[api] 服务器返回非 JSON 响应:", text.slice(0, 200));
    throw new Error("服务器响应格式异常，请刷新页面后重试。");
  }
  if (!response.ok) throw new Error(body.error ?? "请求失败，请稍后重试。");
  return body as T;
}

export const api = {
  dashboard: () => request<DashboardSnapshot>("/api/dashboard"),
  office: () => request<OfficeSnapshot>("/api/office"),
  capabilities: () => request<TikTokCapabilitiesResponse>("/api/capabilities"),
  chat: (input: ChatRequest) => request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify(input) }),
  // 流式对话：通过 SSE 实时推送步骤进度和最终回答，首字时间从 10-30s 降到 <1s
  chatStream: async (input: ChatRequest, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<ChatResponse> => {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let message = "处理指令失败。";
      try { const body = JSON.parse(text); message = body.error ?? message; } catch { /* ignore */ }
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResponse: ChatResponse | undefined;
    let streamError: string | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as ChatStreamEvent;
        if (event.type === "final") finalResponse = event.response;
        else if (event.type === "error") streamError = event.message;
        else onEvent(event);
      }
    }
    // 服务端中途失败会先推 {type:"error"} 再结束流：把真实原因透传给调用方
    if (!finalResponse) throw new Error(streamError ?? "流式响应意外结束。");
    return finalResponse;
  },
  approve: (actionId: string) => request<ActionResponse>(`/api/actions/${actionId}/approve`, { method: "POST" }),
  reject: (actionId: string) => request<{ plan: { status: string } }>(`/api/actions/${actionId}/reject`, { method: "POST" }),
  toggleAutomation: (automationId: string) =>
    request<{ automation: DashboardSnapshot["automations"][number] }>(`/api/automations/${automationId}/toggle`, { method: "POST" }),
  selectTikTokShop: (shopId: string, grantId?: string) =>
    request<{ tiktok: TikTokConnectionStatus }>("/api/tiktok/shop", { method: "POST", body: JSON.stringify(grantId ? { shopId, grantId } : { shopId }) }),
  tiktokBindings: () => request<{ bindings: TikTokBindingSummary[]; tiktok: TikTokConnectionStatus }>("/api/tiktok/bindings"),
  unbindTikTokBinding: (grantId: string) =>
    request<{ ok: boolean; tiktok: TikTokConnectionStatus }>(`/api/tiktok/bindings/${encodeURIComponent(grantId)}`, { method: "DELETE" }),
  health: () => request<HealthResponse>("/api/health"),
  contentOverview: () => request<ContentOverview>("/api/content"),
  intelligenceOverview: () => request<IntelligenceOverview>("/api/intelligence"),
  searchKnowledge: (query: string, scope = "general") => request<{ matches: KnowledgeMatch[] }>(`/api/intelligence/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`),
  webSearch: (input: WebSearchInput) => request<WebSearchResponse>("/api/intelligence/web-search", { method: "POST", body: JSON.stringify(input) }),
  createKnowledge: (input: { title: string; content: string; category: KnowledgeCategory; scope: IntelligenceScope; source: string; tags: string[]; enabled?: boolean; priority?: number }) =>
    request<{ entry: KnowledgeEntry }>("/api/intelligence/knowledge", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledge: (id: string, input: Partial<{ title: string; content: string; category: KnowledgeCategory; scope: IntelligenceScope; source: string; tags: string[]; enabled: boolean; priority: number }>) =>
    request<{ entry: KnowledgeEntry }>(`/api/intelligence/knowledge/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteKnowledge: (id: string) => request<{ ok: boolean }>(`/api/intelligence/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createPromptRule: (input: { name: string; instruction: string; scope: IntelligenceScope; enabled?: boolean; priority?: number }) =>
    request<{ rule: PromptRule }>("/api/intelligence/prompts", { method: "POST", body: JSON.stringify(input) }),
  updatePromptRule: (id: string, input: Partial<{ name: string; instruction: string; scope: IntelligenceScope; enabled: boolean; priority: number }>) =>
    request<{ rule: PromptRule }>(`/api/intelligence/prompts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deletePromptRule: (id: string) => request<{ ok: boolean }>(`/api/intelligence/prompts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createTextContent: (input: { title?: string; prompt: string; project?: string; sku?: string; kind: "title" | "listing" | "script"; language?: string }) =>
    request<{ task: ContentTask; asset: ContentAsset }>("/api/content/text", { method: "POST", body: JSON.stringify(input) }),
  createImageContent: (input: { title?: string; prompt: string; project?: string; sku?: string; ratio: string; size: string; images?: string[] }) =>
    request<{ task: ContentTask; asset: ContentAsset }>("/api/content/images", { method: "POST", body: JSON.stringify(input) }),
  createVideoContent: (input: { title?: string; prompt: string; project?: string; sku?: string; ratio: string; resolution: string; duration: number; assetIds?: string[]; images?: string[] }) =>
    request<{ task: ContentTask }>("/api/content/videos", { method: "POST", body: JSON.stringify(input) }),
  kolOverview: () => request<KolOverviewResponse>("/api/kol/overview"),
  kolCreators: (query: { category?: string; minFollowers?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.category) params.set("category", query.category);
    if (query.minFollowers !== undefined) params.set("minFollowers", String(query.minFollowers));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return request<{ creators: KolCreator[]; source: "browser_bridge" }>(`/api/kol/creators${params.size ? `?${params}` : ""}`);
  },
  kolStats: () => request<{ stats: KolStats; source: "browser_bridge" }>("/api/kol/stats"),

  workflows: () => request<WorkflowListResponse>("/api/workflows"),
  workflow: (id: string) => request<{ run: BusinessWorkflowRun }>(`/api/workflows/${id}`),
  workflowHistory: (id: string) => request<{ events: WorkflowHistoryItem[] }>(`/api/workflows/${id}/history`),
  startProductPublishWorkflow: (input: {
    sourceUrl: string;
    shopId?: string;
    publishPrice?: number;
    currency?: string;
    packageDimensions?: { length: number; width: number; height: number };
    title?: string;
    description?: string;
  }) =>
    request<{ run: ProductPublishWorkflowRun }>("/api/workflows/product-publish", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startFlashSaleWorkflow: (input: {
    productId: string;
    activityTitle: string;
    startAt: string;
    endAt: string;
    priceAmount: string;
    currency?: string;
    pricingLevel?: "PRODUCT" | "VARIATION";
    skuIds?: string[];
    skuQuantityLimit: number;
    quantityPerUser: number;
  }) => request<{ run: FlashSaleWorkflowRun }>("/api/workflows/flash-sale", { method: "POST", body: JSON.stringify(input) }),
  startKolOutreachWorkflow: (input: {
    category?: string;
    minFollowers?: number;
    commissionRate: number;
    message?: string;
    batchSize: number;
    totalTarget: number;
    freeSample: boolean;
  }) => request<{ run: KolOutreachWorkflowRun }>("/api/workflows/kol-outreach", { method: "POST", body: JSON.stringify(input) }),
  selectWorkflowShop: (id: string, shopId: string) =>
    request<{ run: ProductPublishWorkflowRun }>(`/api/workflows/${id}/shop`, {
      method: "POST",
      body: JSON.stringify({ shopId }),
    }),
  updateWorkflowProductInput: (id: string, input: { publishPrice: number; packageDimensions?: { length: number; width: number; height: number }; title?: string; description?: string }) =>
    request<{ run: ProductPublishWorkflowRun }>(`/api/workflows/${id}/product-input`, { method: "POST", body: JSON.stringify(input) }),
  approveWorkflow: (id: string) => request<{ run: BusinessWorkflowRun }>(`/api/workflows/${id}/approve`, { method: "POST" }),
  retryWorkflow: (id: string) => request<{ run: BusinessWorkflowRun }>(`/api/workflows/${id}/retry`, { method: "POST" }),
  verifyWorkflow: (id: string) => request<{ run: BusinessWorkflowRun }>(`/api/workflows/${id}/verify`, { method: "POST" }),
  recheckWorkflowReadiness: (id: string) => request<{ run: ProductPublishWorkflowRun }>(`/api/workflows/${id}/readiness`, { method: "POST" }),
  cancelWorkflow: (id: string) => request<{ run: BusinessWorkflowRun }>(`/api/workflows/${id}/cancel`, { method: "POST" }),

  // Skill 管理
  skills: () => request<SkillsCatalogResponse>("/api/skills"),
  installSkill: (skillId: string) => request<SkillStatus>(`/api/skills/${skillId}/install`, { method: "POST" }),
  uninstallSkill: (skillId: string) => request<{ ok: boolean }>(`/api/skills/${skillId}/uninstall`, { method: "POST" }),
  enableSkill: (skillId: string) => request<SkillStatus>(`/api/skills/${skillId}/enable`, { method: "POST" }),
  disableSkill: (skillId: string) => request<SkillStatus>(`/api/skills/${skillId}/disable`, { method: "POST" }),
  updateSkillConfig: (skillId: string, config: Record<string, string>) =>
    request<SkillStatus>(`/api/skills/${skillId}/config`, { method: "PUT", body: JSON.stringify({ config }) }),
  skillConnectionTest: (skillId: string) =>
    request<SkillConnectionTestResult>(`/api/skills/${encodeURIComponent(skillId)}/test`, { method: "POST" }),
  clearSkillConfig: (skillId: string) =>
    request<{ ok: boolean; catalog: SkillsCatalogResponse }>(`/api/skills/${encodeURIComponent(skillId)}/config`, { method: "DELETE" }),

  // 大模型供应商绑定
  llmProviders: () => request<LlmProvidersOverview>("/api/llm/providers"),
  addLlmProvider: (input: { name: string; baseUrl: string; apiKey: string; model: string; fastModel?: string }) =>
    request<{ provider: LlmProviderSummary; overview: LlmProvidersOverview }>("/api/llm/providers", { method: "POST", body: JSON.stringify(input) }),
  updateLlmProvider: (id: string, input: { name?: string; baseUrl?: string; apiKey?: string; model?: string; fastModel?: string }) =>
    request<{ provider: LlmProviderSummary; overview: LlmProvidersOverview }>(`/api/llm/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteLlmProvider: (id: string) =>
    request<{ ok: boolean; overview: LlmProvidersOverview }>(`/api/llm/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  activateLlmProvider: (id: string) =>
    request<{ provider: LlmProviderSummary; overview: LlmProvidersOverview }>(`/api/llm/providers/${encodeURIComponent(id)}/activate`, { method: "POST" }),
  importLlmEnvProvider: () =>
    request<{ provider: LlmProviderSummary; overview: LlmProvidersOverview }>("/api/llm/providers/import-env", { method: "POST" }),
  testLlmProvider: (input: { id?: string; baseUrl?: string; apiKey?: string; model?: string }) =>
    request<LlmProviderTestResult>("/api/llm/providers/test", { method: "POST", body: JSON.stringify(input) }),
  llmProviderModels: (input: { id?: string; baseUrl?: string; apiKey?: string }) =>
    request<{ models: string[]; error?: string }>("/api/llm/providers/models", { method: "POST", body: JSON.stringify(input) }),
};
