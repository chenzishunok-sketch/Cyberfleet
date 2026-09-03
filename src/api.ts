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
  PricingDefaults,
  SkuActualSettlementInput,
  SkuPricingInput,
  SkuPricingRecord,
  SupplierPricingPreview,
  TikTokCapabilitiesResponse,
  SkillsCatalogResponse,
  SkillStatus,
  WorkflowListResponse,
  WorkflowHistoryItem,
  OfficeSnapshot,
} from "../shared/contracts";
import type { ContentAsset, ContentOverview, ContentTask } from "../shared/content";
import type { IntelligenceOverview, IntelligenceScope, KnowledgeCategory, KnowledgeEntry, KnowledgeMatch, PromptRule, WebSearchInput, WebSearchResponse } from "../shared/intelligence";

export interface TikTokConnectionStatus {
  status: "not_configured" | "ready_to_authorize" | "shop_selection_required" | "connected" | "expired";
  connected: boolean;
  shopName?: string;
  region?: string;
  expiresAt?: number;
  shops?: Array<{ id: string; name: string; region: string }>;
}

export interface HealthResponse {
  ok: boolean;
  mode: "demo" | "connected" | "setup";
  connections: { llm: boolean; tiktok: boolean; miaoshou: boolean; tmapi: boolean; kolBridge: boolean };
  tiktok: TikTokConnectionStatus;
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
        else onEvent(event);
      }
    }
    if (!finalResponse) throw new Error("流式响应意外结束。");
    return finalResponse;
  },
  approve: (actionId: string) => request<ActionResponse>(`/api/actions/${actionId}/approve`, { method: "POST" }),
  reject: (actionId: string) => request<{ plan: { status: string } }>(`/api/actions/${actionId}/reject`, { method: "POST" }),
  toggleAutomation: (automationId: string) =>
    request<{ automation: DashboardSnapshot["automations"][number] }>(`/api/automations/${automationId}/toggle`, { method: "POST" }),
  selectTikTokShop: (shopId: string) => request<{ tiktok: TikTokConnectionStatus }>("/api/tiktok/shop", { method: "POST", body: JSON.stringify({ shopId }) }),
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
  pricingRecords: (workflowId?: string) => request<{ records: SkuPricingRecord[] }>(`/api/pricing${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`),
  pricingHistory: (workflowId: string) => request<{ records: SkuPricingRecord[] }>(`/api/pricing/history/${encodeURIComponent(workflowId)}`),
  syncPricingRecords: () => request<{ records: SkuPricingRecord[]; totalProducts: number; totalSkus: number; created: number; updated: number; unchanged: number; missingCost: number; inactiveProducts: number; inactiveSkus: number; matchedCategoryProducts: number; unmatchedCategoryProducts: number }>("/api/pricing/sync", { method: "POST" }),
  updateProductPricing: (productId: string, values: Partial<SkuPricingInput>) =>
    request<{ records: SkuPricingRecord[]; updated: number }>(`/api/pricing/product/${encodeURIComponent(productId)}`, { method: "PATCH", body: JSON.stringify({ values }) }),
  preview1688Pricing: (productId: string, sourceUrl: string) =>
    request<{ preview: SupplierPricingPreview }>(`/api/pricing/product/${encodeURIComponent(productId)}/1688/preview`, { method: "POST", body: JSON.stringify({ sourceUrl }) }),
  apply1688Pricing: (productId: string, sourceUrl: string) =>
    request<{ records: SkuPricingRecord[]; updated: number; linked: number; preview: SupplierPricingPreview }>(`/api/pricing/product/${encodeURIComponent(productId)}/1688/apply`, { method: "POST", body: JSON.stringify({ sourceUrl }) }),
  updatePricingRecord: (id: string, input: { input?: Partial<SkuPricingInput>; actual?: Partial<SkuActualSettlementInput> }) =>
    request<{ record: SkuPricingRecord }>(`/api/pricing/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
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
  updateWorkflowPricing: (id: string, input: { defaults?: Partial<PricingDefaults>; skus?: Array<{ skuKey: string; values: Partial<SkuPricingInput> }>; removedSkuKeys?: string[] }) =>
    request<{ run: ProductPublishWorkflowRun }>(`/api/workflows/${id}/pricing`, { method: "POST", body: JSON.stringify(input) }),
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
};
