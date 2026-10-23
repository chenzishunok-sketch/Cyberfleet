import { describe, expect, it } from "vitest";
import { startAfterNow } from "../server/flash-sale-autostart.ts";

describe("flash-sale-autostart", () => {
  it("computes start time as now + delay minutes (absolute timestamp, timezone-agnostic)", () => {
    // 固定一个「现在」时刻：2026-10-23 07:00:00 UTC
    const nowMs = Date.UTC(2026, 9, 23, 7, 0, 0);
    const start = startAfterNow(3, nowMs);
    // 3 分钟后 = 07:03:00 UTC
    expect(start.toISOString()).toBe("2026-10-23T07:03:00.000Z");
  });

  it("does not double-apply the JP timezone offset", () => {
    // 日本时间「现在」和服务器「现在」是同一绝对时刻，+3 分钟不该额外加 9 小时
    const nowMs = Date.UTC(2026, 9, 23, 7, 0, 0);
    const start = startAfterNow(3, nowMs);
    // 若错误叠加 UTC+9，会得到 16:03 而非 07:03
    expect(start.getTime() - nowMs).toBe(3 * 60 * 1000);
  });
});
