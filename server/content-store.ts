import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContentAsset, ContentAssetType, ContentTask } from "../shared/content.ts";

interface PayloadRow { payload: string }

/**
 * 解析一行 payload。
 *
 * 内容是按整条 JSON 存进 payload 列的，历史上 schema 改过几次。一条对不上就整页 500
 * 是划不来的——跳过这条，其余照常显示，用户至少还能看到大部分内容。
 */
function parseRow<T>(row: PayloadRow, label: string): T | undefined {
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    console.warn(`[ContentStore] 跳过一条损坏的${label}记录`);
    return undefined;
  }
}

function databasePath(): string {
  const configured = process.env.WORKFLOW_DATABASE?.trim();
  return configured ? resolve(configured) : join(process.cwd(), ".data", "workflows.sqlite");
}

export class ContentStore {
  private db?: DatabaseSync;

  listAssets(type?: ContentAssetType): ContentAsset[] {
    const rows = type
      ? this.database().prepare("SELECT payload FROM content_assets WHERE type = ? ORDER BY created_at DESC").all(type)
      : this.database().prepare("SELECT payload FROM content_assets ORDER BY created_at DESC").all();
    return (rows as unknown as PayloadRow[]).flatMap((row) => {
      const asset = parseRow<ContentAsset>(row, "素材");
      return asset ? [asset] : [];
    });
  }

  getAsset(id: string): ContentAsset | undefined {
    const row = this.database().prepare("SELECT payload FROM content_assets WHERE id = ?").get(id) as unknown as PayloadRow | undefined;
    return row ? parseRow<ContentAsset>(row, "素材") : undefined;
  }

  saveAsset(asset: ContentAsset): ContentAsset {
    this.database().prepare(`
      INSERT INTO content_assets (id, type, title, project, sku, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, title = excluded.title, project = excluded.project, sku = excluded.sku
    `).run(asset.id, asset.type, asset.title, asset.project ?? null, asset.sku ?? null, JSON.stringify(asset), asset.createdAt);
    return asset;
  }

  listTasks(): ContentTask[] {
    const rows = this.database().prepare("SELECT payload FROM content_tasks ORDER BY updated_at DESC").all() as unknown as PayloadRow[];
    return rows.flatMap((row) => {
      const task = parseRow<ContentTask>(row, "任务");
      return task ? [task] : [];
    });
  }

  getTask(id: string): ContentTask | undefined {
    const row = this.database().prepare("SELECT payload FROM content_tasks WHERE id = ?").get(id) as unknown as PayloadRow | undefined;
    return row ? parseRow<ContentTask>(row, "任务") : undefined;
  }

  saveTask(task: ContentTask): ContentTask {
    this.database().prepare(`
      INSERT INTO content_tasks (id, type, status, provider_task_id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, provider_task_id = excluded.provider_task_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(task.id, task.type, task.status, task.providerTaskId ?? null, JSON.stringify(task), task.createdAt, task.updatedAt);
    return task;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    const path = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_assets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        project TEXT,
        sku TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS content_assets_type_idx ON content_assets(type, created_at DESC);
      CREATE TABLE IF NOT EXISTS content_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_task_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS content_tasks_status_idx ON content_tasks(status, updated_at DESC);
    `);
    chmodSync(path, 0o600);
    return this.db;
  }
}

export const contentStore = new ContentStore();
