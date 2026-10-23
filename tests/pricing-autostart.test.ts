import { describe, expect, it } from "vitest";
import { inferCategoryFromTitle } from "../server/pricing-autostart.ts";

describe("pricing-autostart", () => {
  it("infers 宠物用品 from pet keywords", () => {
    expect(inferCategoryFromTitle("宠物专用餐垫防水防滑猫咪碗粮垫狗狗大号")).toBe("宠物用品");
    expect(inferCategoryFromTitle("猫窝保暖四季通用")).toBe("宠物用品");
  });

  it("infers 家纺布艺 from textile keywords", () => {
    expect(inferCategoryFromTitle("加厚珊瑚绒毛毯床单单人被套")).toBe("家纺布艺");
  });

  it("infers 服饰配件 from apparel keywords", () => {
    expect(inferCategoryFromTitle("冬季保暖手套针织羊毛手套")).toBe("服饰配件");
  });

  it("returns empty string when no keyword matches", () => {
    expect(inferCategoryFromTitle("创意礼品收纳盒")).toBe("家居日用");
    expect(inferCategoryFromTitle("")).toBe("");
    expect(inferCategoryFromTitle(undefined)).toBe("");
  });
});
