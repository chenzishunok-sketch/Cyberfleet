import { execFileSync } from "node:child_process";

/**
 * 飞书定价表格读取（通过 lark-cli 命令，复用已认证的 bot 身份）。
 *
 * 为什么走 lark-cli 而不是直接调飞书 open API：
 * - 项目 .env 里 FEISHU_APP_ID / FEISHU_APP_SECRET 为空，.data/skills.json 也不存在，
 *   项目侧没有可用的飞书应用凭证；
 * - lark-cli 已有独立的 bot 认证（appId cli_aaf57bb8f438dccd），--as bot 身份含
 *   sheets:spreadsheet:write_only / read 权限，读写均可用，且 appSecret 由其自身
 *   在 keychain 里管理，不暴露给项目。
 *
 * 因此这里复用 lark-cli 作为飞书表格的访问通道，避免在项目里再补一套飞书凭证。
 */

export interface FeishuPricingRow {
  /** 飞书总表的物理行号（1 起） */
  row: number;
  /** B 列：1688 item_id */
  itemId: string;
  /** C 列：类目名 */
  category: string;
  /** V 列：定价（JPY，秒杀价） */
  priceJpy: number;
  /** Y 列：商品原价（JPY，划线价） */
  originalPriceJpy: number;
}

/** 默认定价总表地址（用户固定的那张表） */
export const FEISHU_PRICING_SHEET_URL = "https://acni2t3spk0q.feishu.cn/wiki/IJXbwLyNUiJjFjk2z8Fccyn9nDe";

/** 从带千分位的字符串里取数字（"1,416" → 1416；空 → undefined） */
function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/,/g, "").replace(/[¥￥\s]/g, "").trim();
  if (!cleaned || cleaned === "-") return undefined;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : undefined;
}

/** 解析 lark-cli +csv-get 返回的 annotated_csv：每行 `[row=N] ` 前缀 + 逗号分隔的列 */
export function parseAnnotatedCsv(csv: string, colIndices: string[]): Array<{ row: number; cells: Record<string, string> }> {
  const rows: Array<{ row: number; cells: Record<string, string> }> = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\[row=(\d+)\]\s*(.*)$/);
    if (!match) continue;
    const row = Number(match[1]);
    const cells: Record<string, string> = {};
    const raw = match[2];
    const parts = splitCsvLine(raw);
    colIndices.forEach((col, idx) => {
      cells[col] = parts[idx] ?? "";
    });
    rows.push({ row, cells });
  }
  return rows;
}

/**
 * lark-cli 的 annotated_csv 对含千分位逗号的单元格（如 `"1,416"`）用引号包裹，
 * 直接 split(',') 会把引号内的千分位逗号当成列分隔符，把一格拆成两格。
 * 这里按 RFC 4180 的「引号内逗号」规则切分：字段内逗号不切，引号闭合后才切。
 */
export function splitCsvLine(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => {
    const p = part.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) return p.slice(1, -1);
    return p;
  });
}

/** 执行 lark-cli sheets +csv-get，返回解析后的 JSON data（含 col_indices / annotated_csv） */
function readSheetRange(
  sheetUrl: string,
  sheetName: string,
  range: string,
): { colIndices: string[]; rows: Array<{ row: number; cells: Record<string, string> }> } {
  const output = execFileSync(
    "lark-cli",
    ["sheets", "+csv-get", "--as", "bot", "--url", sheetUrl, "--sheet-name", sheetName, "--range", range],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const payload = JSON.parse(output) as { ok?: boolean; data?: { col_indices?: string[]; annotated_csv?: string; actual_range?: string } };
  if (!payload.ok || !payload.data) {
    throw new Error("飞书表格读取失败：" + (output.slice(0, 300) || "lark-cli 未返回有效数据"));
  }
  const colIndices = payload.data.col_indices ?? [];
  const csv = payload.data.annotated_csv ?? "";
  return { colIndices, rows: parseAnnotatedCsv(csv, colIndices) };
}

/**
 * 读飞书定价总表全部数据行，按 1688 item_id 匹配对应行。
 * 表头在第 3 行，数据从第 4 行起；B 列 = item_id，V 列 = 定价，Y 列 = 商品原价。
 */
export function readPricingRowByItemId(
  itemId: string,
  opts: { sheetUrl?: string; sheetName?: string } = {},
): FeishuPricingRow | undefined {
  const sheetUrl = opts.sheetUrl ?? FEISHU_PRICING_SHEET_URL;
  const sheetName = opts.sheetName ?? "总表";
  // 读 A3:BC 后面的数据区；表较大（198 行），一次读 A4:BC200 覆盖全部数据行
  const { rows } = readSheetRange(sheetUrl, sheetName, "A4:BC200");
  for (const row of rows) {
    const b = (row.cells["B"] ?? "").trim();
    if (b && b === itemId.trim()) {
      const priceJpy = parseNumber(row.cells["V"]);
      const originalPriceJpy = parseNumber(row.cells["Y"]);
      return {
        row: row.row,
        itemId: b,
        category: (row.cells["C"] ?? "").trim(),
        priceJpy: priceJpy ?? 0,
        originalPriceJpy: originalPriceJpy ?? 0,
      };
    }
  }
  return undefined;
}

/** 从 1688 链接提取 item_id */
export function extract1688ItemId(sourceUrl: string): string | undefined {
  const match = sourceUrl.match(/offer\/(\d+)/i);
  return match?.[1];
}

/**
 * 查飞书总表首个空白数据行号（表头第 3 行，数据第 4 行起）。
 * 判定：B 列（PID）为空即视为空白行。返回首个空白行的行号。
 */
export function findFirstEmptyRow(opts: { sheetUrl?: string; sheetName?: string } = {}): number {
  const sheetUrl = opts.sheetUrl ?? FEISHU_PRICING_SHEET_URL;
  const sheetName = opts.sheetName ?? "总表";
  const { rows } = readSheetRange(sheetUrl, sheetName, "A4:BC200");
  const occupied = new Set<number>();
  for (const row of rows) {
    const b = (row.cells["B"] ?? "").trim();
    if (b) occupied.add(row.row);
  }
  // 从第 4 行起找第一个未被占用的行
  for (let rowNum = 4; rowNum <= 200; rowNum++) {
    if (!occupied.has(rowNum)) return rowNum;
  }
  throw new Error("飞书总表数据区（第 4-200 行）已满，无法确定空白行。");
}

/** 单个飞书写入单元（值或公式） */
interface FeishuWriteCell {
  sheet_name: string;
  range: string;
  cells: Array<Array<Record<string, unknown>>>;
}

/**
 * 把定价脚本生成的载荷（值 + 公式）写入飞书总表指定行。
 * 流程：复制上一行样式 → 写入载荷 → 校验公式。
 * 返回 formula-verify 的结果摘要。
 */
export function writePricingRow(
  row: number,
  writes: FeishuWriteCell[],
  opts: { sheetUrl?: string; sheetName?: string } = {},
): { succeeded: number; failed: number; formulaStatus: string; formulaErrors: number } {
  const sheetUrl = opts.sheetUrl ?? FEISHU_PRICING_SHEET_URL;
  const sheetName = opts.sheetName ?? "总表";
  const prevRow = row - 1;

  // 1) 复制上一行样式到目标行（formats，不复制内容）
  execFileSync(
    "lark-cli",
    ["sheets", "+range-copy", "--as", "bot", "--url", sheetUrl, "--sheet-name", sheetName,
      "--source-range", `A${prevRow}:BL${prevRow}`, "--target-range", `A${row}`, "--paste-type", "formats"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );

  // 2) 写入载荷（值 + 公式）
  const writesJson = JSON.stringify(writes);
  const setOutput = execFileSync(
    "lark-cli",
    ["sheets", "+cells-set", "--as", "bot", "--url", sheetUrl, "--writes", "-"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024, input: writesJson },
  );
  const setPayload = JSON.parse(setOutput) as { ok?: boolean; data?: { succeeded?: number; failed?: number } };
  if (!setPayload.ok || !setPayload.data) {
    throw new Error("飞书定价行写入失败：" + (setOutput.slice(0, 300) || "lark-cli 未返回有效数据"));
  }

  // 3) 校验公式
  const verifyOutput = execFileSync(
    "lark-cli",
    ["sheets", "+formula-verify", "--as", "bot", "--url", sheetUrl, "--sheet-name", sheetName, "--range", `A${row}:BC${row}`],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const verifyPayload = JSON.parse(verifyOutput) as { ok?: boolean; data?: { status?: string; total_errors?: number } };

  return {
    succeeded: setPayload.data.succeeded ?? 0,
    failed: setPayload.data.failed ?? 0,
    formulaStatus: verifyPayload.data?.status ?? "unknown",
    formulaErrors: verifyPayload.data?.total_errors ?? -1,
  };
}
