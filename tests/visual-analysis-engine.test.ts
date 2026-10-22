import { describe, expect, it } from "vitest";
import { detectVisualPatterns, tryBuildVisualArtifact } from "../server/visual-analysis-engine.ts";

describe("visual-analysis-engine · 视觉增强判定", () => {
  it("纯文字结论、没有任何数据时，不生成 visual_analysis 空壳卡", () => {
    const artifact = tryBuildVisualArtifact(
      "总体来看，公共采集箱目前有 3 个待认领商品，建议尽快处理。我的判断是其中 2 个已重复，可以先删除重复项。",
    );
    expect(artifact).toBeUndefined();
  });

  it("只有一句结论、无数据高亮时，也不生成空壳卡", () => {
    const artifact = tryBuildVisualArtifact(
      "结论：这个品类近期竞争加剧，建议调整定价策略。",
    );
    expect(artifact).toBeUndefined();
  });

  it("包含真实数据时正常生成卡片，且标题不是一整句话", () => {
    const artifact = tryBuildVisualArtifact(
      "结论：本季度 GMV ¥1,234,567 较上季度增长 12.3%。退货率 3.2%，环比下降 0.5%。建议下一步优化详情页转化率。",
    );
    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("visual_analysis");
    // 标题不能带原始数字/货币，也不能是一整句（含句号）
    const headline = artifact && artifact.kind === "visual_analysis" ? artifact.headline : "";
    expect(headline.length).toBeLessThanOrEqual(20);
    expect(headline).not.toMatch(/[。；]/);
    expect(headline).not.toMatch(/\d/);
    // 必须有可可视化的数据段
    const sections = artifact && artifact.kind === "visual_analysis" ? artifact.sections : [];
    expect(sections.some((s) => s.type === "data_highlights" || s.type === "bar_chart" || s.type === "donut_chart")).toBe(true);
  });

  it("detectVisualPatterns 对纯文字只产出 callout、不含数据段", () => {
    const result = detectVisualPatterns("我认为这个类目值得做，建议尽快上架。");
    expect(result.sections.every((s) => s.type === "callout")).toBe(true);
    expect(result.sections.some((s) => s.type === "data_highlights" || s.type === "bar_chart")).toBe(false);
  });
});
