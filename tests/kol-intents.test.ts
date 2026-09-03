import { describe, expect, it } from "vitest";
import { parseKolIntent } from "../server/kol-intents.ts";

describe("KOL natural-language intents", () => {
  it("extracts a complete outreach plan", () => {
    expect(parseKolIntent("给 50 位粉丝超过 10 万的美妆达人发邀约，佣金 15%，每批 10 位，提供免费样品，话术：你好，想邀请你合作"))
      .toMatchObject({
        kind: "outreach",
        input: {
          category: "美妆",
          minFollowers: 100_000,
          commissionRate: 15,
          batchSize: 10,
          totalTarget: 50,
          freeSample: true,
          message: "你好，想邀请你合作",
        },
      });
  });

  it("treats outreach data as a read-only statistics request", () => {
    expect(parseKolIntent("查看达人建联数据", true)).toEqual({ kind: "stats" });
  });

  it("understands creator filtering in the dedicated KOL chat", () => {
    expect(parseKolIntent("筛选粉丝超过 10 万的美妆达人", true)).toEqual({
      kind: "creators",
      category: "美妆",
      minFollowers: 100_000,
    });
  });

  it("does not hijack ordinary store questions in the global chat", () => {
    expect(parseKolIntent("查看店铺库存")).toBeUndefined();
  });
});
