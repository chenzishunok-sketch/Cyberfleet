import { beforeEach, describe, expect, it, vi } from "vitest";

const miaoshou = vi.hoisted(() => ({
  fetchItem: vi.fn(),
  getShopDetail: vi.fn(),
  saveShopDetail: vi.fn(),
  waitForCollection: vi.fn(),
  getShopList: vi.fn(),
  claimToShop: vi.fn(),
  resolveMiaoshouShopId: vi.fn(),
}));

const tiktokAuth = vi.hoisted(() => ({
  readStoredAuthorization: vi.fn(),
}));

vi.mock("../server/tiktok-auth.ts", () => ({
  getAuthorizedTikTokClient: vi.fn(),
  readStoredAuthorization: tiktokAuth.readStoredAuthorization,
}));

vi.mock("../server/miaoshou-client.ts", () => ({
  hasMiaoshouConfiguration: vi.fn(() => true),
  miaoshouAiGenerateProductInfo: vi.fn(),
  miaoshouAiMatchAttribute: vi.fn(),
  miaoshouAiMatchCategory: vi.fn(),
  miaoshouClaimToPlatform: vi.fn(),
  miaoshouClaimToShop: miaoshou.claimToShop,
  miaoshouFetchItem: miaoshou.fetchItem,
  miaoshouGetPublishRecords: vi.fn(),
  miaoshouGetShopList: miaoshou.getShopList,
  miaoshouGetTikTokCollectBoxList: vi.fn(),
  miaoshouGetTikTokCategoryMetadata: vi.fn(),
  miaoshouGetTikTokShopCollectItemInfo: miaoshou.getShopDetail,
  miaoshouPublishToTikTok: vi.fn(),
  miaoshouSaveTikTokShopCollectItemInfo: miaoshou.saveShopDetail,
  miaoshouTranslateItem: vi.fn(),
  miaoshouWaitForCollection: miaoshou.waitForCollection,
  resolveMiaoshouShopId: miaoshou.resolveMiaoshouShopId,
}));

import { realProductPublishWorkflowTools } from "../server/product-publish-workflow.ts";

describe("Real product publishing tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the verified successful collection instead of the raw fetch mapping", async () => {
    miaoshou.fetchItem.mockResolvedValue({
      data: { sourceItemIdAndDetailIdMap: { "648795280915": 3840811341 } },
    });
    miaoshou.waitForCollection
      .mockResolvedValueOnce([{ sourceItemId: "648795280915", detailId: "" }])
      .mockResolvedValueOnce([{ sourceItemId: "648795280915", detailId: "3840810276" }]);

    await expect(realProductPublishWorkflowTools.collect("https://detail.1688.com/offer/648795280915.html"))
      .resolves.toEqual({ sourceItemId: "648795280915", commonDetailId: "3840810276" });
    // 复用探测必须给足时间（否则会误判成"没采过"而重复采集），真正采集后同样要等妙手异步落库
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(1, ["648795280915"], 20_000, 3_000);
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(2, ["648795280915"], 90_000, 3_000);
  });

  it("also polls when the collection response has no detail id yet", async () => {
    miaoshou.fetchItem.mockResolvedValue({
      data: { sourceItemIdAndDetailIdMap: { "648795280915": null } },
    });
    miaoshou.waitForCollection
      .mockResolvedValueOnce([{ sourceItemId: "648795280915", detailId: "" }])
      .mockResolvedValueOnce([{ sourceItemId: "648795280915", detailId: "3840810456" }]);

    await expect(realProductPublishWorkflowTools.collect("https://detail.1688.com/offer/648795280915.html"))
      .resolves.toEqual({ sourceItemId: "648795280915", commonDetailId: "3840810456" });
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(2, ["648795280915"], 90_000, 3_000);
  });

  it("reuses an existing successful collection without creating a duplicate", async () => {
    // 重复调用 fetch_item 不会创建新副本，只会得到 status="skip" 且没有 payload 的重复行，
    // 认领它就报「存在未采集成功的产品」。所以已有 success 记录时必须复用、绝不重复采集。
    miaoshou.waitForCollection.mockResolvedValue([
      { sourceItemId: "648795280915", detailId: "3840810276" },
    ]);

    await expect(realProductPublishWorkflowTools.collect("https://detail.1688.com/offer/648795280915.html?offerId=648795280915"))
      .resolves.toEqual({ sourceItemId: "648795280915", commonDetailId: "3840810276", reused: true });
    expect(miaoshou.fetchItem).not.toHaveBeenCalled();
    expect(miaoshou.waitForCollection).toHaveBeenCalledWith(["648795280915"], 20_000, 3_000);
  });

  it("updates both the sale price and the local display price for every active SKU", async () => {
    miaoshou.getShopDetail.mockResolvedValue({
      data: {
        ossMd5: "latest-md5",
        shopCollectItemInfo: {
          title: "Product",
          deliveryOptionSetType: "",
          packageLength: 10,
          packageWidth: 8,
          packageHeight: 4,
          skuMap: {
            active: { price: 14.9, priceIncludeVat: 14.9, isDelete: "0", weight: 0.4 },
            deleted: { price: 9.9, priceIncludeVat: 9.9, isDelete: "1", weight: 0.4 },
          },
        },
      },
    });
    miaoshou.saveShopDetail.mockResolvedValue({ result: "success" });

    await realProductPublishWorkflowTools.saveEdit?.({
      platformDetailId: "3228311508",
      shopId: "16047893",
      publishPrice: 99,
    });

    expect(miaoshou.saveShopDetail).toHaveBeenCalledTimes(1);
    const savedItem = miaoshou.saveShopDetail.mock.calls[0][3];
    expect(savedItem.skuMap.active).toMatchObject({ price: 99, priceIncludeVat: 99 });
    expect(savedItem.skuMap.deleted).toMatchObject({ price: 9.9, priceIncludeVat: 9.9 });
    expect(savedItem.deliveryOptionSetType).toBe("default");
  });

  it("removes unselected SKUs and rounds valid package dimensions before saving", async () => {
    miaoshou.getShopDetail.mockResolvedValue({
      data: {
        ossMd5: "latest-md5",
        shopCollectItemInfo: {
          title: "Product",
          deliveryOptionSetType: "default",
          packageLength: 0,
          packageWidth: 0,
          packageHeight: 0,
          skuMap: {
            keep: { price: 20, priceIncludeVat: 20, isDelete: "0", weight: 0.4 },
            remove: { price: 20, priceIncludeVat: 20, isDelete: "0", weight: 0.4 },
          },
        },
      },
    });
    miaoshou.saveShopDetail.mockResolvedValue({ result: "success" });

    await realProductPublishWorkflowTools.saveEdit?.({
      platformDetailId: "3228311508",
      shopId: "16047893",
      publishPrice: 99,
      selectedSkuKeys: ["keep"],
      packageDimensions: { length: 12.1, width: 8.2, height: 3.1 },
    });

    const savedItem = miaoshou.saveShopDetail.mock.calls[0][3];
    expect(savedItem.skuMap.keep).toMatchObject({ price: 99, priceIncludeVat: 99, isDelete: "0" });
    expect(savedItem.skuMap.remove).toMatchObject({ isDelete: "1" });
    expect(savedItem).toMatchObject({ packageLength: 13, packageWidth: 9, packageHeight: 4 });
  });

  it("stops before save when required package dimensions are missing", async () => {
    miaoshou.getShopDetail.mockResolvedValue({
      data: {
        ossMd5: "latest-md5",
        shopCollectItemInfo: {
          title: "Product",
          deliveryOptionSetType: "default",
          packageLength: 0,
          packageWidth: 0,
          packageHeight: 0,
          skuMap: { active: { price: 20, priceIncludeVat: 20, isDelete: "0", weight: 0.4 } },
        },
      },
    });

    await expect(realProductPublishWorkflowTools.saveEdit?.({
      platformDetailId: "3228311508",
      shopId: "16047893",
      publishPrice: 99,
    })).rejects.toThrow("实际包裹长、宽、高");
    expect(miaoshou.saveShopDetail).not.toHaveBeenCalled();
  });
});

describe("listShops 的 OAuth 店铺 → 妙手店铺映射", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // site=all 在真实环境中返回 0 家，listShops 会回退到按 region 逐个站点查询
    miaoshou.getShopList.mockImplementation(async (_platform: string, site: string) => {
      if (site === "all") return { data: { shopList: [] } };
      if (site === "JP") {
        return {
          data: {
            shopList: [
              // 妙手返回顺序：同站点、不同名的店铺排在前面
              { shopId: 10562706, site: "JP", platformShopName: "Mizora JP", shopNick: null },
              { shopId: 8536938, site: "JP", platformShopName: "Cashio", shopNick: null },
            ],
          },
        };
      }
      return { data: { shopList: [] } };
    });
    tiktokAuth.readStoredAuthorization.mockResolvedValue({
      shops: [{ id: "7494753869954254912", cipher: "ROW_cashio", name: "Cashio", region: "JP" }],
    });
  });

  it("按店铺名称精确匹配，不会因为同站点就命中排在前面的另一家店", async () => {
    const shops = await realProductPublishWorkflowTools.listShops();

    const cashio = shops.find((shop) => shop.id === "ROW_cashio");
    expect(cashio).toMatchObject({ name: "Cashio", site: "JP" });
    // 关键断言：必须是同名店铺 8536938，而不是同站点的 Mizora JP 10562706
    expect(cashio?.miaoshouShopId).toBe("8536938");
    // 名称已经唯一命中，不应再退化到站点试探
    expect(miaoshou.resolveMiaoshouShopId).not.toHaveBeenCalled();
  });

  it("名称对不上且同站点有多家店时留空，交由用户显式选择而不是猜一家", async () => {
    tiktokAuth.readStoredAuthorization.mockResolvedValue({
      shops: [{ id: "7494753869954254912", cipher: "ROW_unknown", name: "未关联店铺", region: "JP" }],
    });
    miaoshou.resolveMiaoshouShopId.mockResolvedValue(undefined);

    const shops = await realProductPublishWorkflowTools.listShops();
    const unknown = shops.find((shop) => shop.id === "ROW_unknown");
    expect(unknown?.miaoshouShopId).toBeUndefined();
  });

  it("同站点只有唯一一家妙手店铺时才允许按站点兜底", async () => {
    miaoshou.getShopList.mockImplementation(async (_platform: string, site: string) => {
      if (site === "all") return { data: { shopList: [] } };
      if (site === "JP") {
        return { data: { shopList: [{ shopId: 8536938, site: "JP", platformShopName: "Cashio", shopNick: null }] } };
      }
      return { data: { shopList: [] } };
    });
    tiktokAuth.readStoredAuthorization.mockResolvedValue({
      shops: [{ id: "7494753869954254912", cipher: "ROW_only", name: "另一个名字", region: "JP" }],
    });

    const shops = await realProductPublishWorkflowTools.listShops();
    expect(shops.find((shop) => shop.id === "ROW_only")?.miaoshouShopId).toBe("8536938");
  });
});

describe("claimToShop 解析妙手店铺 ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    miaoshou.claimToShop.mockResolvedValue({ result: "success" });
  });

  it("把 region / shopName 传给解析函数，而不是退化成逐个站点试探", async () => {
    miaoshou.resolveMiaoshouShopId.mockResolvedValue("8536938");

    await realProductPublishWorkflowTools.claimToShop?.("3381559921", "ROW_cashio", {
      region: "JP",
      shopName: "Cashio",
    });

    // 缺了这两个参数时，解析函数只能按站点优先级列表盲试，日本站会直接解析失败
    expect(miaoshou.resolveMiaoshouShopId).toHaveBeenCalledWith("ROW_cashio", {
      region: "JP",
      shopName: "Cashio",
    });
    expect(miaoshou.claimToShop).toHaveBeenCalledWith([3381559921], [8536938]);
  });

  it("解析不出来时抛出可读错误，不带着 cipher 去调妙手", async () => {
    miaoshou.resolveMiaoshouShopId.mockResolvedValue(undefined);

    await expect(
      realProductPublishWorkflowTools.claimToShop?.("3381559921", "ROW_cashio", { region: "JP", shopName: "Cashio" }),
    ).rejects.toThrow("缺少有效的妙手店铺 ID");
    expect(miaoshou.claimToShop).not.toHaveBeenCalled();
  });
});
