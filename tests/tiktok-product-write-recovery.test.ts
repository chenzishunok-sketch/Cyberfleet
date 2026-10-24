import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inventory: 5,
  writeCalls: 0,
  plans: new Map<string, unknown>(),
  request: vi.fn(),
}));

vi.mock("../server/action-plan-store.ts", () => ({
  actionPlanStore: {
    get: (id: string) => structuredClone(state.plans.get(id)),
    save: (plan: { core: { id: string } }) => state.plans.set(plan.core.id, structuredClone(plan)),
  },
}));

vi.mock("../server/tiktok-auth.ts", () => ({
  readStoredAuthorization: vi.fn(async () => ({
    selectedShopCipher: "cipher-th",
    grantedScopes: ["seller.product.write"],
    shops: [{ id: "shop-jp", name: "Mikolo", cipher: "cipher-th", region: "JP" }],
  })),
  getAuthorizedTikTokClient: vi.fn(async () => ({ request: state.request })),
}));

vi.mock("../server/tiktok-data.ts", () => ({
  clearTikTokDataCache: vi.fn(),
  getCurrentDashboard: vi.fn(async () => ({
    dataSource: "tiktok",
    store: { id: "shop-jp", name: "Mikolo", region: "JP", currency: "JPY", timezone: "Asia/Tokyo", connected: true },
    metrics: [], salesSeries: [], products: [], activity: [], alerts: [], dataAsOf: "now",
  })),
}));

import {
  ActionVerificationPendingError,
  approveTikTokProductWrite,
  prepareTikTokProductWrite,
} from "../server/tiktok-product-writes.ts";

function product() {
  return {
    id: "1736000000000000001",
    title: "Recovery test product",
    status: "ACTIVATE",
    skus: [{ id: "1736000000000000002", seller_sku: "SKU-RECOVERY", inventory: [{ warehouse_id: "warehouse-th", quantity: state.inventory }] }],
  };
}

describe("TikTok write recovery", () => {
  beforeEach(() => {
    state.inventory = 5;
    state.writeCalls = 0;
    state.plans.clear();
    state.request.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith("/inventory/update")) {
        state.writeCalls += 1;
        state.inventory = 7;
        throw new Error("response timeout");
      }
      if (path.endsWith("/products/search")) return { data: { products: [product()], total_count: 1 } };
      return { data: product() };
    });
  });

  it("rechecks an uncertain write without submitting it twice", async () => {
    const plan = await prepareTikTokProductWrite("inventory.update", "将 SKU-RECOVERY 库存修改为 7");
    await expect(approveTikTokProductWrite(plan.id)).rejects.toBeInstanceOf(ActionVerificationPendingError);
    expect(state.writeCalls).toBe(1);
    expect(state.plans.get(plan.id)).toMatchObject({ status: "verification_pending" });

    const recovered = await approveTikTokProductWrite(plan.id);
    expect(recovered?.plan.status).toBe("approved");
    expect(state.writeCalls).toBe(1);
  });
});
