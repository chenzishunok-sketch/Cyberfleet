import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface ActionPlanRow {
  payload: string;
}

interface RecoverablePlan {
  core: { id: string; kind: string; expiresAt: string };
  status: string;
  plan?: { status: string };
}

export interface ActionPlanRecoverySummary {
  expired: number;
  verificationPending: number;
  /** 解析失败被跳过的记录数。有一条坏数据不该让整批恢复中断 */
  skipped: number;
}

function databasePath(): string {
  const configured = process.env.ACTION_PLAN_DATABASE?.trim() || process.env.WORKFLOW_DATABASE?.trim();
  return configured ? resolve(configured) : join(process.cwd(), ".data", "workflows.sqlite");
}

export class ActionPlanStore {
  private db?: DatabaseSync;

  constructor(private readonly explicitPath?: string) {}

  get<T>(id: string): T | undefined {
    const row = this.database().prepare("SELECT payload FROM action_plans WHERE id = ?").get(id) as unknown as ActionPlanRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      // 一条损坏的记录不该让审批入口直接 500。按「找不到」处理，
      // 用户会收到"计划已失效，请重新生成"，比一个 500 有用。
      console.warn(`[ActionPlanStore] 计划 ${id} 的数据已损坏，按不存在处理`);
      return undefined;
    }
  }

  save<T extends { core: { id: string; kind: string; expiresAt: string }; status: string }>(plan: T): void {
    const now = new Date().toISOString();
    this.database().prepare(`
      INSERT INTO action_plans (id, kind, status, payload, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(plan.core.id, plan.core.kind, plan.status, JSON.stringify(plan), plan.core.expiresAt, now, now);
  }

  recoverInterruptedPlans(now = Date.now()): ActionPlanRecoverySummary {
    const rows = this.database().prepare(`
      SELECT payload FROM action_plans WHERE status IN ('pending', 'executing')
    `).all() as unknown as ActionPlanRow[];
    const summary = { expired: 0, verificationPending: 0, skipped: 0 };
    for (const row of rows) {
      let plan: RecoverablePlan;
      try {
        plan = JSON.parse(row.payload) as RecoverablePlan;
      } catch {
        // 以前这里是裸 parse：一条坏数据抛错，整个恢复循环中断，
        // 后面所有待恢复的计划都不会被处理，服务启动日志里只会看到一条 unhandledRejection。
        summary.skipped += 1;
        console.warn("[ActionPlanStore] 跳过一条损坏的待恢复计划");
        continue;
      }
      const nextStatus = plan.status === "executing"
        ? "verification_pending"
        : new Date(plan.core.expiresAt).getTime() < now ? "expired" : undefined;
      if (!nextStatus) continue;
      plan.status = nextStatus;
      if (plan.plan) plan.plan.status = nextStatus;
      this.save(plan);
      if (nextStatus === "expired") summary.expired += 1;
      else summary.verificationPending += 1;
    }
    return summary;
  }

  /** 按状态统计审批计划数量（用于办公室实时统计卡） */
  countByStatus(statuses: readonly string[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.database().prepare(
      `SELECT COUNT(*) AS count FROM action_plans WHERE status IN (${placeholders})`,
    ).get(...statuses) as unknown as { count: number };
    return row.count;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    const path = this.explicitPath ? resolve(this.explicitPath) : databasePath();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_plans (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_plans_status_idx ON action_plans(status, expires_at);
    `);
    chmodSync(path, 0o600);
    return this.db;
  }
}

export const actionPlanStore = new ActionPlanStore();
