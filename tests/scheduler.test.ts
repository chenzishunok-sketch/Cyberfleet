import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulerEngine } from "../server/scheduler.ts";

// 这一组守的是定时任务的两个致命行为：
//  1. 失败一次就永久停用 —— 一次网络抖动会让任务静默消失，界面上看不出来
//  2. 长任务被重复触发 —— setInterval 不等上一轮跑完，写类任务会执行两遍
describe("SchedulerEngine", () => {
  let directory: string;
  let engine: SchedulerEngine;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-scheduler-"));
    // 必须指定临时路径：默认会写进项目真实的 .data/scheduler-tasks.json
    engine = new SchedulerEngine(path.join(directory, "tasks.json"));
  });

  afterEach(async () => {
    engine.stop();
    await rm(directory, { recursive: true, force: true });
  });

  function createTask(cron = "0 0 * * *") {
    return engine.create({ name: "测试任务", cron, type: "read_only_query", params: {} });
  }

  it("单次失败不会停用任务，只记录失败结果", async () => {
    engine.registerExecutor("read_only_query", async () => ({ success: false, summary: "网络抖动" }));
    const task = createTask();

    await engine.runOnce(task.id);

    expect(engine.get(task.id)?.status).toBe("active");
    expect(engine.get(task.id)?.lastResult).toMatchObject({ success: false });
  });

  it("连续失败 5 次才停用，中途成功会清零计数", async () => {
    let succeed = false;
    engine.registerExecutor("read_only_query", async () => (
      succeed ? { success: true, summary: "ok" } : { success: false, summary: "失败" }
    ));
    const task = createTask();

    // 连续 4 次失败：仍然在跑
    for (let i = 0; i < 4; i += 1) await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("active");

    // 成功一次，计数清零
    succeed = true;
    await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("active");

    // 再次连续 4 次失败：因为计数已清零，仍然不该停用
    succeed = false;
    for (let i = 0; i < 4; i += 1) await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("active");

    // 第 5 次连续失败才停用
    await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("error");
  });

  it("手动恢复任务会清零失败计数", async () => {
    engine.registerExecutor("read_only_query", async () => ({ success: false, summary: "失败" }));
    const task = createTask();
    for (let i = 0; i < 5; i += 1) await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("error");

    engine.resume(task.id);
    expect(engine.get(task.id)?.status).toBe("active");
    // 恢复后只失败一次不该立刻又被停用
    await engine.runOnce(task.id);
    expect(engine.get(task.id)?.status).toBe("active");
  });

  it("任务文件里有坏数据时只跳过坏的那条，其余照常加载", async () => {
    const file = path.join(directory, "corrupt.json");
    const good = {
      id: "t1", name: "好任务", cron: "0 4 1 1 *", type: "read_only_query",
      params: {}, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(file, JSON.stringify({
      tasks: [good, null, { id: "no-cron" }, { ...good, id: "t2", name: "第二个任务" }],
      logs: [{ taskId: "t1", taskName: "好任务", runAt: "2026-01-01T00:00:00.000Z", success: true, summary: "ok", durationMs: 1 }, { nope: true }],
    }), "utf-8");

    const loaded = new SchedulerEngine(file);
    loaded.start();
    loaded.stop();

    // 以前一条 null 就会让整批任务都加载失败，界面变成 0 个任务
    expect(loaded.list().map((task) => task.id).sort()).toEqual(["t1", "t2"]);
    expect(loaded.getLogs()).toHaveLength(1);
  });

  it("上一轮 tick 还没跑完时，下一次触发不会重复执行", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    engine.registerExecutor("read_only_query", async () => {
      runs += 1;
      await blocked;
      return { success: true, summary: "ok" };
    });
    createTask("* * * * *");

    const first = engine.tick();
    // 让第一次 tick 走到 executor 里的 await
    await Promise.resolve();
    await Promise.resolve();
    // 这时第二次触发应当被守卫挡下，而不是把同一个任务再跑一遍
    await engine.tick();
    expect(runs).toBe(1);

    release();
    await first;
    expect(runs).toBe(1);
  });
});
