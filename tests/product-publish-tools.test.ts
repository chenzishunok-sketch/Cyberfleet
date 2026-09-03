import { beforeEach, describe, expect, it, vi } from "vitest";

const miaoshou = vi.hoisted(() => ({
  fetchItem: vi.fn(),
  getShopDetail: vi.fn(),
  saveShopDetail: vi.fn(),
  waitForCollection: vi.fn(),
}));

vi.mock("../server/miaoshou-client.ts", () => ({
  hasMiaoshouConfiguration: vi.fn(() => true),
  miaoshouAiGenerateProductInfo: vi.fn(),
  miaoshouAiMatchAttribute: vi.fn(),
  miaoshouAiMatchCategory: vi.fn(),
  miaoshouClaimToPlatform: vi.fn(),
  miaoshouClaimToShop: vi.fn(),
  miaoshouFetchItem: miaoshou.fetchItem,
  miaoshouGetPublishRecords: vi.fn(),
  miaoshouGetShopList: vi.fn(),
  miaoshouGetTikTokCollectBoxList: vi.fn(),
  miaoshouGetTikTokCategoryMetadata: vi.fn(),
  miaoshouGetTikTokShopCollectItemInfo: miaoshou.getShopDetail,
  miaoshouPublishToTikTok: vi.fn(),
  miaoshouSaveTikTokShopCollectItemInfo: miaoshou.saveShopDetail,
  miaoshouTranslateItem: vi.fn(),
  miaoshouWaitForCollection: miaoshou.waitForCollection,
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
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(1, ["648795280915"], 1_500, 500);
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(2, ["648795280915"], 40_000, 3_000);
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
    expect(miaoshou.waitForCollection).toHaveBeenNthCalledWith(2, ["648795280915"], 40_000, 3_000);
  });

  it("reuses an existing successful collection without creating a duplicate", async () => {
    miaoshou.waitForCollection.mockResolvedValue([
      { sourceItemId: "648795280915", detailId: "3840810276" },
    ]);

    await expect(realProductPublishWorkflowTools.collect("https://detail.1688.com/offer/648795280915.html?offerId=648795280915"))
      .resolves.toEqual({ sourceItemId: "648795280915", commonDetailId: "3840810276" });
    expect(miaoshou.fetchItem).not.toHaveBeenCalled();
    expect(miaoshou.waitForCollection).toHaveBeenCalledWith(["648795280915"], 1_500, 500);
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
