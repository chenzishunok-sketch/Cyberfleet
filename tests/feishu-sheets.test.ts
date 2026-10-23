import { describe, expect, it } from "vitest";
import { extract1688ItemId, parseAnnotatedCsv, splitCsvLine } from "../server/feishu-sheets.ts";

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];

describe("feishu-sheets", () => {
  it("extracts 1688 item_id from offer URL", () => {
    expect(extract1688ItemId("https://detail.1688.com/offer/1060728518472.html")).toBe("1060728518472");
    expect(extract1688ItemId("https://detail.1688.com/offer/844795233724.html?spm=a")).toBe("844795233724");
    expect(extract1688ItemId("https://example.com/no-offer-here")).toBeUndefined();
  });

  it("splits a CSV line with quoted thousand-separator numbers", () => {
    // 千分位逗号被引号包裹，splitCsvLine 不应在引号内切分
    const line = `,1060728518472,宠物用品,9%,普货,50*32*3,50,32,3,0.60,0.37,0.60,,5.5,3.5,0,764,32.32,,41.32,,"1,416",59.90,,"3,540",60%`;
    const parts = splitCsvLine(line);
    expect(parts[1]).toBe("1060728518472");
    expect(parts[2]).toBe("宠物用品");
    expect(parts[21]).toBe("1,416"); // V 列定价，千分位逗号保留在值里，由 parseNumber 后续去除
    expect(parts[24]).toBe("3,540"); // Y 列原价
  });

  it("parses annotated CSV into rows keyed by column letter", () => {
    const csv = [
      "[row=3] ,PID,类目",
      `[row=11] ,1060728518472,宠物用品,9%,普货,50*32*3,50,32,3,0.60,0.37,0.60,,5.5,3.5,0,764,32.32,,41.32,,"1,416",59.90,,"3,540",60%`,
    ].join("\n");
    const rows = parseAnnotatedCsv(csv, COLS);
    expect(rows).toHaveLength(2);
    expect(rows[1].row).toBe(11);
    expect(rows[1].cells["B"]).toBe("1060728518472");
    expect(rows[1].cells["C"]).toBe("宠物用品");
    expect(rows[1].cells["V"]).toBe("1,416");
    expect(rows[1].cells["Y"]).toBe("3,540");
  });

  it("keeps column alignment when a quoted number contains a comma", () => {
    // 关键回归：引号内逗号不导致后续列错位
    const line = `,A,B,"1,416",D,"3,540",F`;
    const parts = splitCsvLine(line);
    expect(parts).toEqual(["", "A", "B", "1,416", "D", "3,540", "F"]);
  });
});
