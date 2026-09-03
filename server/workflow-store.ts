import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BusinessWorkflowRun, WorkflowHistoryItem } from "../shared/contracts.ts";

const MAX_LISTED_RUNS = 500;

interface WorkflowRow {
  payload: string;
}

interface HistoryRow {
  id: number;
  run_id: string;
  step_id: string | null;
  event_type: WorkflowHistoryItem["eventType"];
  status: string;
  detail: string | null;
  error: string | null;
  payload: string;
  created_at: string;
}

function configuredDatabasePath(): string {
  const configured = process.env.WORKFLOW_DATABASE?.trim();
  return configured ? resolve(configured) : join(process.cwd(), ".data", "workflows.sqlite");
}

function legacyStorePath(): string {
  const configured = process.env.WORKFLOW_STORE?.trim();
  return configured ? resolve(configured) : join(process.cwd(), ".data", "workflow-runs.json");
}

function cloneRun<T extends BusinessWorkflowRun>(run: T): T {
  return structuredClone(run);
}

function parseRun(payload: string): BusinessWorkflowRun {
  return JSON.parse(payload) as BusinessWorkflowRun;
}

function changedStep(before: BusinessWorkflowRun, after: BusinessWorkflowRun) {
  // DAG 工作流：检查 nodeStates 变化
  if ("nodeStates" in after && "nodeStates" in before) {
    return after.nodeStates.find((node) => {
      const previous = (before as { nodeStates: Array<{ id: string }> }).nodeStates.find((n) => n.id === node.id);
      return !previous || JSON.stringify(previous) !== JSON.stringify(node);
    }) as unknown as { id: string; detail?: string; error?: string } | undefined;
  }
  // 传统工作流：检查 steps 变化
  if (!("steps" in after) || !("steps" in before)) return undefined;
  return after.steps.find((step) => {
    const previous = (before as { steps: Array<{ id: string }> }).steps.find((item) => item.id === step.id);
    return !previous || JSON.stringify(previous) !== JSON.stringify(step);
  });
}

export class WorkflowStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private db?: DatabaseSync;

  constructor(private readonly explicitPath?: string, private readonly explicitLegacyPath?: string) {}

  async list(): Promise<BusinessWorkflowRun[]> {
    await this.mutationQueue;
    const rows = this.database().prepare(`
      SELECT payload FROM workflow_runs
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(MAX_LISTED_RUNS) as unknown as WorkflowRow[];
    return rows.map((row) => cloneRun(parseRun(row.payload)));
  }

  async get(id: string): Promise<BusinessWorkflowRun | undefined> {
    await this.mutationQueue;
    const row = this.database().prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(id) as unknown as WorkflowRow | undefined;
    return row ? cloneRun(parseRun(row.payload)) : undefined;
  }

  /** 按状态统计工作流数量（用于办公室实时统计卡） */
  async countByStatus(statuses: readonly string[]): Promise<number> {
    await this.mutationQueue;
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.database().prepare(
      `SELECT COUNT(*) AS count FROM workflow_runs WHERE status IN (${placeholders})`,
    ).get(...statuses) as unknown as { count: number };
    return row.count;
  }

  /** 统计今日完成的工作流数量（updated_at 存 UTC ISO 串，"今天"按本地时区零点换算成 UTC 再比较） */
  async countCompletedToday(now = new Date()): Promise<number> {
    await this.mutationQueue;
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const row = this.database().prepare(
      "SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'completed' AND updated_at >= ?",
    ).get(localMidnight.toISOString()) as unknown as { count: number };
    return row.count;
  }

  async history(id: string): Promise<WorkflowHistoryItem[]> {
    await this.mutationQueue;
    const rows = this.database().prepare(`
      SELECT id, run_id, step_id, event_type, status, detail, error, payload, created_at
      FROM workflow_events
      WHERE run_id = ?
      ORDER BY id ASC
    `).all(id) as unknown as HistoryRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id ?? undefined,
      eventType: row.event_type,
      status: row.status,
      detail: row.detail ?? undefined,
      error: row.error ?? undefined,
      snapshot: cloneRun(parseRun(row.payload)),
      createdAt: row.created_at,
    }));
  }

  async recoverInterruptedRuns(): Promise<{ failed: number; verificationPending: number }> {
    return this.mutate((database) => {
      const rows = database.prepare("SELECT payload FROM workflow_runs WHERE status = 'running'").all() as unknown as WorkflowRow[];
      const summary = { failed: 0, verificationPending: 0 };
      for (const row of rows) {
        const run = parseRun(row.payload);
        // DAG 工作流恢复
        if ("nodeStates" in run) {
          const dagRun = run as import("../shared/contracts.ts").DagWorkflowRun;
          const activeNode = dagRun.nodeStates.find((n) => n.state === "running");
          dagRun.status = "failed";
          dagRun.error = "服务在任务执行期间中断，可以从失败节点重试。";
          dagRun.updatedAt = new Date().toISOString();
          if (activeNode) {
            activeNode.state = "failed";
            activeNode.error = "执行中断，可以安全重试";
          }
          this.writeRun(database, dagRun);
          this.writeEvent(database, dagRun, "updated", activeNode?.id, "执行中断", dagRun.error);
          summary.failed += 1;
          continue;
        }
        // 传统工作流恢复
        const step = run.steps.find((item) => item.status === "running");
        const needsVerification = Boolean(
          step && (
            (run.type === "product_publish" && ["publish", "verify"].includes(step.id))
            || (run.type === "flash_sale" && Boolean(run.activityId) && ["create_activity", "bind_skus", "verify"].includes(step.id))
            || (run.type === "kol_outreach" && ["execute", "verify"].includes(step.id))
          ),
        );
        run.status = needsVerification ? "verification_pending" : "failed";
        run.error = needsVerification ? undefined : "服务在任务执行期间中断，可以从当前步骤安全重试。";
        run.summary = needsVerification
          ? "服务在提交后中断，系统不会重复执行；请先核验平台中的最新结果。"
          : "服务在任务执行期间中断，任务已停止，等待手动重试。";
        run.updatedAt = new Date().toISOString();
        if (step) {
          step.status = needsVerification ? "pending" : "failed";
          step.detail = needsVerification ? "执行中断，等待结果核验" : "执行中断，可以安全重试";
          step.error = run.error;
        }
        this.writeRun(database, run);
        this.writeEvent(database, run, "updated", step?.id, step?.detail, step?.error);
        if (needsVerification) summary.verificationPending += 1;
        else summary.failed += 1;
      }
      return summary;
    });
  }

  async create<T extends BusinessWorkflowRun>(run: T): Promise<T> {
    return this.mutate((database) => {
      const exists = database.prepare("SELECT 1 AS found FROM workflow_runs WHERE id = ?").get(run.id);
      if (exists) throw new Error("任务编号重复，无法创建任务。");
      this.writeRun(database, run);
      this.writeEvent(database, run, "created");
      return cloneRun(run);
    });
  }

  async update<T extends BusinessWorkflowRun>(
    id: string,
    updater: (run: T) => T,
  ): Promise<T> {
    return this.mutate((database) => {
      const row = database.prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(id) as unknown as WorkflowRow | undefined;
      if (!row) throw new Error("找不到这个业务任务。");
      const before = parseRun(row.payload) as T;
      const next = updater(cloneRun(before));
      next.updatedAt = new Date().toISOString();
      this.writeRun(database, next);
      const step = changedStep(before, next);
      this.writeEvent(database, next, "updated", step?.id, step?.detail, step?.error ?? next.error);
      return cloneRun(next);
    });
  }

  private async mutate<T>(mutator: (database: DatabaseSync) => T): Promise<T> {
    let result!: T;
    const operation = this.mutationQueue.then(() => {
      const database = this.database();
      database.exec("BEGIN IMMEDIATE");
      try {
        result = mutator(database);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
    this.mutationQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    const databasePath = this.explicitPath ? resolve(this.explicitPath) : configuredDatabasePath();
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source_url TEXT,
        shop_id TEXT,
        common_detail_id TEXT,
        platform_detail_id TEXT,
        activity_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        error TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflow_events_run_idx ON workflow_events(run_id, id);
    `);
    chmodSync(databasePath, 0o600);
    if (!this.explicitPath || this.explicitLegacyPath) this.migrateLegacyJson(this.db);
    return this.db;
  }

  private migrateLegacyJson(database: DatabaseSync): void {
    const existing = database.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number };
    const filePath = this.explicitLegacyPath ? resolve(this.explicitLegacyPath) : legacyStorePath();
    if (existing.count > 0 || !existsSync(filePath)) return;
    let runs: BusinessWorkflowRun[];
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { version?: number; runs?: BusinessWorkflowRun[] };
      runs = parsed.version === 1 && Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch (error) {
      throw new Error(`迁移旧任务记录失败：${error instanceof Error ? error.message : "文件无法读取"}`);
    }
    if (!runs.length) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const run of runs) {
        this.writeRun(database, run);
        this.writeEvent(database, run, "migrated", undefined, "从旧版 JSON 任务记录迁移");
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRun(database: DatabaseSync, run: BusinessWorkflowRun): void {
    database.prepare(`
      INSERT INTO workflow_runs (
        id, type, title, status, source_url, shop_id, common_detail_id,
        platform_detail_id, activity_id, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        status = excluded.status,
        source_url = excluded.source_url,
        shop_id = excluded.shop_id,
        common_detail_id = excluded.common_detail_id,
        platform_detail_id = excluded.platform_detail_id,
        activity_id = excluded.activity_id,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      run.type,
      run.title,
      run.status,
      run.type === "product_publish" ? run.sourceUrl : null,
      ("shopId" in run) ? run.shopId ?? null : null,
      run.type === "product_publish" ? run.commonDetailId ?? null : null,
      run.type === "product_publish" ? run.platformDetailId ?? null : null,
      run.type === "flash_sale" ? run.activityId ?? null : null,
      JSON.stringify(run),
      run.createdAt,
      run.updatedAt,
    );
  }

  private writeEvent(
    database: DatabaseSync,
    run: BusinessWorkflowRun,
    eventType: WorkflowHistoryItem["eventType"],
    stepId?: string,
    detail?: string,
    error?: string,
  ): void {
    database.prepare(`
      INSERT INTO workflow_events (run_id, step_id, event_type, status, detail, error, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, stepId ?? null, eventType, run.status, detail ?? null, error ?? null, JSON.stringify(run), new Date().toISOString());
  }

}

export const workflowStore = new WorkflowStore();
