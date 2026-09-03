import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SkuPricingRecord } from "../shared/contracts.ts";

interface PricingRow { payload: string }

function databasePath(): string {
  const configured = process.env.WORKFLOW_DATABASE?.trim();
  return configured ? resolve(configured) : join(process.cwd(), ".data", "workflows.sqlite");
}

export class PricingStore {
  private db?: DatabaseSync;
  constructor(private readonly explicitPath?: string) {}

  list(): SkuPricingRecord[] {
    const rows = this.database().prepare(`
      SELECT payload FROM sku_pricing_records ORDER BY updated_at DESC, sku_name ASC
    `).all() as unknown as PricingRow[];
    return rows.map((row) => JSON.parse(row.payload) as SkuPricingRecord);
  }

  listByWorkflow(workflowId: string): SkuPricingRecord[] {
    const rows = this.database().prepare(`
      SELECT payload FROM sku_pricing_records WHERE workflow_id = ? ORDER BY sku_name ASC
    `).all(workflowId) as unknown as PricingRow[];
    return rows.map((row) => JSON.parse(row.payload) as SkuPricingRecord);
  }

  get(id: string): SkuPricingRecord | undefined {
    const row = this.database().prepare("SELECT payload FROM sku_pricing_records WHERE id = ?").get(id) as unknown as PricingRow | undefined;
    return row ? JSON.parse(row.payload) as SkuPricingRecord : undefined;
  }

  update(id: string, updater: (record: SkuPricingRecord) => SkuPricingRecord): SkuPricingRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const updated = updater(current);
    this.upsert(this.listByWorkflow(current.workflowId).map((record) => record.id === id ? updated : record));
    return updated;
  }

  history(workflowId: string): SkuPricingRecord[] {
    const rows = this.database().prepare(`
      SELECT payload FROM sku_pricing_snapshots WHERE workflow_id = ? ORDER BY id ASC
    `).all(workflowId) as unknown as PricingRow[];
    return rows.map((row) => JSON.parse(row.payload) as SkuPricingRecord);
  }

  historyAll(): SkuPricingRecord[] {
    const rows = this.database().prepare(`
      SELECT payload FROM sku_pricing_snapshots ORDER BY id ASC
    `).all() as unknown as PricingRow[];
    return rows.map((row) => JSON.parse(row.payload) as SkuPricingRecord);
  }

  upsert(records: SkuPricingRecord[]): void {
    if (!records.length) return;
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const workflowGroups = new Map<string, string[]>();
      for (const record of records) workflowGroups.set(record.workflowId, [...(workflowGroups.get(record.workflowId) ?? []), record.id]);
      for (const [workflowId, ids] of workflowGroups) {
        const placeholders = ids.map(() => "?").join(", ");
        database.prepare(`DELETE FROM sku_pricing_records WHERE workflow_id = ? AND id NOT IN (${placeholders})`).run(workflowId, ...ids);
      }
      const current = database.prepare(`
        INSERT INTO sku_pricing_records (
          id, workflow_id, source_item_id, platform_detail_id, shop_id, sku_key,
          sku_name, category_id, expected_profit_thb, expected_margin, profitable,
          payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_item_id = excluded.source_item_id,
          platform_detail_id = excluded.platform_detail_id,
          shop_id = excluded.shop_id,
          sku_key = excluded.sku_key,
          sku_name = excluded.sku_name,
          category_id = excluded.category_id,
          expected_profit_thb = excluded.expected_profit_thb,
          expected_margin = excluded.expected_margin,
          profitable = excluded.profitable,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `);
      const snapshot = database.prepare(`
        INSERT INTO sku_pricing_snapshots (record_id, workflow_id, sku_key, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        const existing = database.prepare("SELECT payload FROM sku_pricing_records WHERE id = ?").get(record.id) as unknown as PricingRow | undefined;
        const payload = JSON.stringify(record);
        current.run(
          record.id, record.workflowId, record.sourceItemId ?? null, record.platformDetailId ?? null,
          record.shopId ?? null, record.skuKey, record.skuName, record.categoryId ?? null,
          record.result.expectedProfitThb, record.result.expectedMargin, record.result.profitable ? 1 : 0,
          payload, existing ? JSON.parse(existing.payload).calculatedAt : record.calculatedAt, record.calculatedAt,
        );
        if (!existing || existing.payload !== payload) {
          snapshot.run(record.id, record.workflowId, record.skuKey, payload, record.calculatedAt);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    const path = this.explicitPath ? resolve(this.explicitPath) : databasePath();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sku_pricing_records (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        source_item_id TEXT,
        platform_detail_id TEXT,
        shop_id TEXT,
        sku_key TEXT NOT NULL,
        sku_name TEXT NOT NULL,
        category_id TEXT,
        expected_profit_thb REAL NOT NULL,
        expected_margin REAL NOT NULL,
        profitable INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sku_pricing_workflow_idx ON sku_pricing_records(workflow_id, sku_name);
      CREATE INDEX IF NOT EXISTS sku_pricing_source_idx ON sku_pricing_records(source_item_id, platform_detail_id);
      CREATE TABLE IF NOT EXISTS sku_pricing_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        sku_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sku_pricing_history_idx ON sku_pricing_snapshots(workflow_id, id);
    `);
    chmodSync(path, 0o600);
    return this.db;
  }
}

export const pricingStore = new PricingStore();
