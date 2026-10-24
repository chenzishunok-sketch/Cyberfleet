import { describe, expect, it } from "vitest";
import { describeCron } from "../shared/cron-label.ts";

describe("describeCron", () => {
  const cases: Array<[string, string]> = [
    ["0 18 * * *", "每天 18:00"],
    ["30 9 * * *", "每天 09:30"],
    ["0 * * * *", "每小时第 0 分"],
    ["*/15 * * * *", "每 15 分钟"],
    ["* * * * *", "每分钟"],
    ["0 9 * * 1", "每周一 09:00"],
    ["0 20 * * 0", "每周日 20:00"],
    ["0 8 1 * *", "每月 1 日 08:00"],
  ];

  for (const [cron, expected] of cases) {
    it(`${cron} → ${expected}`, () => {
      expect(describeCron(cron)).toBe(expected);
    });
  }

  it("认不出来的表达式原样返回，不编造语义", () => {
    expect(describeCron("0 18 * * 1,3")).toBe("0 18 * * 1,3");
    expect(describeCron("0 18 * * MON")).toBe("0 18 * * MON");
    expect(describeCron("bad")).toBe("bad");
    expect(describeCron("")).toBe("");
  });
});
