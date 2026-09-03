import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, Calculator, Check, ChevronDown, ChevronRight, CloudDownload, Download,
  FileSpreadsheet, Link2, LoaderCircle, Package, Pencil, RefreshCw, Search, Settings2, Sparkles, X,
} from "lucide-react";
import type { SkuActualSettlementInput, SkuPricingInput, SkuPricingRecord, SupplierPricingPreview } from "../../shared/contracts";
import { api } from "../api";

function money(value: number): string {
  return `${value.toFixed(2)} THB`;
}

function cny(value: number): string {
  return `${value.toFixed(2)} CNY`;
}

function priceRange(values: number[]): string {
  if (!values.length) return "--";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? money(min) : `${min.toFixed(2)} - ${max.toFixed(2)} THB`;
}

type PricingDraft = Record<
  | "salePriceThb" | "purchasePriceCny" | "weightKg" | "exchangeRateCnyToThb"
  | "domesticLogisticsCny" | "cloudWarehouseCny" | "buyerLocalDeliveryThb"
  | "advertisingThb" | "creatorCommissionPercent" | "taxPercent" | "categoryCommissionPercent"
  | "period" | "soldQuantity" | "tiktokSettlementThb" | "logisticsDeductionThb"
  | "actualAdvertisingThb" | "actualCreatorCommissionThb",
  string
>;

type BatchPricingField =
  | "purchasePriceCny" | "weightKg" | "exchangeRateCnyToThb" | "domesticLogisticsCny"
  | "cloudWarehouseCny" | "buyerLocalDeliveryThb" | "advertisingThb"
  | "creatorCommissionRate" | "taxRate" | "categoryCommissionRate";

type BatchDraft = Record<
  | "purchasePriceCny" | "weightKg" | "exchangeRateCnyToThb" | "domesticLogisticsCny"
  | "cloudWarehouseCny" | "buyerLocalDeliveryThb" | "advertisingThb"
  | "creatorCommissionPercent" | "taxPercent" | "categoryCommissionPercent",
  string
>;

function draftFor(record: SkuPricingRecord): PricingDraft {
  const actual = record.actualInput ?? {};
  return {
    salePriceThb: String(record.input.salePriceThb),
    purchasePriceCny: String(record.input.purchasePriceCny),
    weightKg: String(record.input.weightKg),
    exchangeRateCnyToThb: String(record.input.exchangeRateCnyToThb),
    domesticLogisticsCny: String(record.input.domesticLogisticsCny),
    cloudWarehouseCny: String(record.input.cloudWarehouseCny),
    buyerLocalDeliveryThb: String(record.input.buyerLocalDeliveryThb),
    advertisingThb: String(record.input.advertisingThb),
    creatorCommissionPercent: String(record.input.creatorCommissionRate * 100),
    taxPercent: String(record.input.taxRate * 100),
    categoryCommissionPercent: String(record.input.categoryCommissionRate * 100),
    period: actual.period ?? "",
    soldQuantity: actual.soldQuantity === undefined ? "" : String(actual.soldQuantity),
    tiktokSettlementThb: actual.tiktokSettlementThb === undefined ? "" : String(actual.tiktokSettlementThb),
    logisticsDeductionThb: actual.logisticsDeductionThb === undefined ? "" : String(actual.logisticsDeductionThb),
    actualAdvertisingThb: String(actual.advertisingThb ?? 0),
    actualCreatorCommissionThb: String(actual.creatorCommissionThb ?? 0),
  };
}

function commonValue(records: SkuPricingRecord[], field: BatchPricingField, multiplier = 1): string {
  if (records.some((record) => record.missingFields.includes(field))) return "";
  const values = new Set(records.map((record) => record.input[field]));
  return values.size === 1 ? String(records[0].input[field] * multiplier) : "";
}

function batchDraftFor(records: SkuPricingRecord[]): BatchDraft {
  return {
    purchasePriceCny: commonValue(records, "purchasePriceCny"),
    weightKg: commonValue(records, "weightKg"),
    exchangeRateCnyToThb: commonValue(records, "exchangeRateCnyToThb"),
    domesticLogisticsCny: commonValue(records, "domesticLogisticsCny"),
    cloudWarehouseCny: commonValue(records, "cloudWarehouseCny"),
    buyerLocalDeliveryThb: commonValue(records, "buyerLocalDeliveryThb"),
    advertisingThb: commonValue(records, "advertisingThb"),
    creatorCommissionPercent: commonValue(records, "creatorCommissionRate", 100),
    taxPercent: commonValue(records, "taxRate", 100),
    categoryCommissionPercent: commonValue(records, "categoryCommissionRate", 100),
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function sourceText(record: SkuPricingRecord, field: keyof SkuPricingInput): string {
  const source = record.fieldSources[field];
  return source === "manual" ? "已修改"
    : source === "category_rule" ? "类目规则"
      : source === "tiktok" ? "TikTok"
        : source === "1688" ? "1688"
          : source === "miaoshou" ? "妙手" : "默认";
}

function pricingGroupKey(record: SkuPricingRecord): string {
  return record.tiktokProductId ?? record.platformDetailId ?? record.sourceItemId ?? record.workflowId;
}

export function PricingWorkspace() {
  const [records, setRecords] = useState<SkuPricingRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<"store" | "loss" | "missing" | "inactive" | "draft">("store");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<PricingDraft>();
  const [batchProductId, setBatchProductId] = useState<string>();
  const [batchDraft, setBatchDraft] = useState<BatchDraft>();
  const [supplierUrl, setSupplierUrl] = useState("");
  const [supplierPreview, setSupplierPreview] = useState<SupplierPricingPreview>();
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const loadedRecords = (await api.pricingRecords()).records;
      setRecords(loadedRecords);
      setCollapsed((current) => current.size ? current : new Set(loadedRecords.map(pricingGroupKey)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "利润记录读取失败。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const storeRecords = useMemo(() => records.filter((record) => record.tiktokProductId && record.tiktokSkuId
    && (record.tiktokStatus === "ACTIVATE" || !record.tiktokStatus)), [records]);
  const inactiveRecords = useMemo(() => records.filter((record) => record.tiktokProductId && record.tiktokSkuId
    && record.tiktokStatus === "INACTIVE"), [records]);
  const draftRecords = useMemo(() => records.filter((record) => !record.tiktokProductId || !record.tiktokSkuId), [records]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const source = filter === "draft" ? draftRecords : filter === "inactive" ? inactiveRecords : storeRecords;
    return source.filter((record) => {
      if (filter === "loss" && (record.missingFields.length > 0 || record.result.profitable)) return false;
      if (filter === "missing" && !record.missingFields.length) return false;
      return !keyword || [record.skuName, record.sourceItemId, record.platformDetailId, record.tiktokProductId,
        record.tiktokSkuId, record.categoryName, record.sellerSku]
        .some((value) => String(value ?? "").toLowerCase().includes(keyword));
    });
  }, [draftRecords, filter, inactiveRecords, query, storeRecords]);

  const groups = useMemo(() => {
    const grouped = new Map<string, SkuPricingRecord[]>();
    for (const record of visible) {
      const key = pricingGroupKey(record);
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return [...grouped.entries()];
  }, [visible]);

  const summaryRecords = filter === "draft" ? draftRecords : filter === "inactive" ? inactiveRecords : storeRecords;
  const productCount = new Set(summaryRecords.map((record) =>
    record.tiktokProductId ?? record.platformDetailId ?? record.sourceItemId ?? record.workflowId)).size;
  const complete = summaryRecords.filter((record) => record.missingFields.length === 0);
  const loss = complete.filter((record) => !record.result.profitable).length;
  const missing = summaryRecords.filter((record) => record.missingFields.length).length;
  const storeComplete = storeRecords.filter((record) => record.missingFields.length === 0);
  const storeLoss = storeComplete.filter((record) => !record.result.profitable).length;
  const storeMissing = storeRecords.filter((record) => record.missingFields.length).length;
  const actualCount = summaryRecords.filter((record) => record.actualResult).length;
  const averageMargin = complete.length
    ? complete.reduce((sum, record) => sum + record.result.expectedMargin, 0) / complete.length
    : 0;
  const exportScope = filter === "draft" ? "draft" : filter === "inactive" ? "inactive" : "store";

  const toggleGroup = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const stopEdit = () => { setEditingId(undefined); setDraft(undefined); };
  const startEdit = (record: SkuPricingRecord) => {
    setBatchProductId(undefined);
    setBatchDraft(undefined);
    setEditingId(record.id);
    setDraft(draftFor(record));
    setError(undefined);
  };
  const changeDraft = (field: keyof PricingDraft, value: string) =>
    setDraft((current) => current ? { ...current, [field]: value } : current);

  const stopBatchEdit = () => {
    setBatchProductId(undefined);
    setBatchDraft(undefined);
    setSupplierUrl("");
    setSupplierPreview(undefined);
  };
  const startBatchEdit = (key: string, productId: string, group: SkuPricingRecord[]) => {
    if (batchProductId === productId) { stopBatchEdit(); return; }
    stopEdit();
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setBatchProductId(productId);
    setBatchDraft(batchDraftFor(group));
    setSupplierUrl(group.find((record) => record.sourceUrl)?.sourceUrl ?? "");
    setSupplierPreview(undefined);
    setError(undefined);
  };
  const changeBatchDraft = (field: keyof BatchDraft, value: string) =>
    setBatchDraft((current) => current ? { ...current, [field]: value } : current);

  const recognizeSupplierPricing = async (productId: string) => {
    const sourceUrl = supplierUrl.trim();
    if (!sourceUrl) {
      setError("请先粘贴 1688 商品链接。");
      return;
    }
    setSupplierLoading(true);
    setSupplierPreview(undefined);
    setError(undefined);
    try {
      const { preview } = await api.preview1688Pricing(productId, sourceUrl);
      setSupplierPreview(preview);
      setBatchDraft((current) => current ? { ...current, purchasePriceCny: "" } : current);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "1688 采购价识别失败。");
    } finally {
      setSupplierLoading(false);
    }
  };

  const saveBatch = async (productId: string, skuCount: number) => {
    if (!batchDraft) return;
    const values: Partial<Record<BatchPricingField, number>> = {};
    const fields: Array<[BatchPricingField, keyof BatchDraft, boolean]> = [
      ["purchasePriceCny", "purchasePriceCny", false],
      ["weightKg", "weightKg", false],
      ["exchangeRateCnyToThb", "exchangeRateCnyToThb", false],
      ["domesticLogisticsCny", "domesticLogisticsCny", false],
      ["cloudWarehouseCny", "cloudWarehouseCny", false],
      ["buyerLocalDeliveryThb", "buyerLocalDeliveryThb", false],
      ["advertisingThb", "advertisingThb", false],
      ["creatorCommissionRate", "creatorCommissionPercent", true],
      ["taxRate", "taxPercent", true],
      ["categoryCommissionRate", "categoryCommissionPercent", true],
    ];
    for (const [inputField, draftField, percentage] of fields) {
      const value = optionalNumber(batchDraft[draftField]);
      if (value !== undefined) values[inputField] = percentage ? value / 100 : value;
    }
    const entries = Object.entries(values);
    const validSourcePreview = supplierPreview?.sourceUrl === supplierUrl.trim();
    const invalid = entries.some(([, value]) => !Number.isFinite(value) || value! < 0)
      || ["purchasePriceCny", "weightKg", "exchangeRateCnyToThb"]
        .some((field) => field in values && values[field as BatchPricingField]! <= 0)
      || ["creatorCommissionRate", "taxRate", "categoryCommissionRate"]
        .some((field) => (values[field as BatchPricingField] ?? 0) > 1);
    if ((!entries.length && !validSourcePreview) || invalid) {
      setError("请至少填写一项有效成本；采购价、重量和汇率必须大于 0，比例不能超过 100%。");
      return;
    }
    if (supplierUrl.trim() && !validSourcePreview) {
      setError("采购链接发生了变化，请先点击“识别采购价”确认 SKU 对应关系。");
      return;
    }
    setBatchSaving(true);
    setError(undefined);
    try {
      let nextRecords = records;
      let supplierUpdated = 0;
      let supplierLinked = 0;
      let commonUpdated = 0;
      if (validSourcePreview) {
        const supplierResult = await api.apply1688Pricing(productId, supplierUrl.trim());
        nextRecords = supplierResult.records;
        supplierUpdated = supplierResult.updated;
        supplierLinked = supplierResult.linked;
      }
      if (entries.length) {
        const result = await api.updateProductPricing(productId, values);
        nextRecords = result.records;
        commonUpdated = result.updated;
      }
      setRecords(nextRecords);
      setSyncResult(supplierUpdated
        ? `已识别并写入 ${supplierUpdated} 个 SKU 的 1688 采购价${commonUpdated ? `，其他成本设置已应用到 ${commonUpdated} 个 SKU` : ""}。`
        : supplierLinked
          ? `已为 ${supplierLinked} 个 SKU 保存 1688 采购来源${commonUpdated ? `，手动成本已应用到 ${commonUpdated} 个 SKU` : "；采购价未自动写入"}。`
          : `已把成本设置应用到当前商品的 ${commonUpdated || skuCount} 个 SKU。`);
      stopBatchEdit();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "商品成本批量保存失败。");
    } finally {
      setBatchSaving(false);
    }
  };

  const save = async (record: SkuPricingRecord) => {
    if (!draft) return;
    const input: Partial<SkuPricingInput> = {
      salePriceThb: Number(draft.salePriceThb),
      purchasePriceCny: Number(draft.purchasePriceCny),
      weightKg: Number(draft.weightKg),
      exchangeRateCnyToThb: Number(draft.exchangeRateCnyToThb),
      domesticLogisticsCny: Number(draft.domesticLogisticsCny),
      cloudWarehouseCny: Number(draft.cloudWarehouseCny),
      buyerLocalDeliveryThb: Number(draft.buyerLocalDeliveryThb),
      advertisingThb: Number(draft.advertisingThb),
      creatorCommissionRate: Number(draft.creatorCommissionPercent) / 100,
      taxRate: Number(draft.taxPercent) / 100,
      categoryCommissionRate: Number(draft.categoryCommissionPercent) / 100,
    };
    const invalid = Object.values(input).some((value) => !Number.isFinite(value) || value! < 0)
      || input.salePriceThb! <= 0 || input.weightKg! <= 0 || input.exchangeRateCnyToThb! <= 0
      || input.creatorCommissionRate! > 1 || input.taxRate! > 1 || input.categoryCommissionRate! > 1;
    if (invalid) {
      setError("请检查成本数据：售价、重量和汇率必须大于 0，比例不能超过 100%。");
      return;
    }
    const actual: Partial<SkuActualSettlementInput> = {
      period: draft.period || undefined,
      soldQuantity: optionalNumber(draft.soldQuantity),
      tiktokSettlementThb: optionalNumber(draft.tiktokSettlementThb),
      logisticsDeductionThb: optionalNumber(draft.logisticsDeductionThb),
      advertisingThb: Number(draft.actualAdvertisingThb),
      creatorCommissionThb: Number(draft.actualCreatorCommissionThb),
    };
    setSaving(true);
    setError(undefined);
    try {
      const { record: updated } = await api.updatePricingRecord(record.id, { input, actual });
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      stopEdit();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "SKU 成本保存失败。");
    } finally {
      setSaving(false);
    }
  };

  const syncStore = async () => {
    setSyncing(true);
    setError(undefined);
    setSyncResult(undefined);
    try {
      const result = await api.syncPricingRecords();
      setRecords(result.records);
      const drafts = result.records.filter((record) => !record.tiktokProductId || !record.tiktokSkuId).length;
      setSyncResult(`在售 ${result.totalProducts} 个商品、${result.totalSkus} 个 SKU 已同步；类目规则匹配 ${result.matchedCategoryProducts}/${result.totalProducts} 个商品；新增 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}。${result.inactiveSkus ? `另保留 ${result.inactiveProducts} 个非在售商品、${result.inactiveSkus} 个历史 SKU。` : ""}${drafts ? `另有 ${drafts} 个上架草稿 SKU 已单独保留。` : ""}`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "TikTok 商品同步失败。");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page-content pricing-workspace">
      <div className="page-header">
        <div>
          <span className="eyebrow">SKU 商品台账</span>
          <h1>商品管理</h1>
          <p>每个 SKU 的默认成本、手工修改、预估利润和实际结算统一保存在本地。</p>
        </div>
        <div className="pricing-page-actions">
          <button className="secondary-button" disabled={syncing} onClick={() => void syncStore()}>
            {syncing ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}同步店铺
          </button>
          <a className="secondary-button" href={`/api/pricing/export.csv?scope=${exportScope}`} download><Download size={15} />CSV</a>
          <a className="primary-button" href={`/api/pricing/export.xlsx?scope=${exportScope}`} download><FileSpreadsheet size={15} />导出 Excel</a>
        </div>
      </div>

      <div className="pricing-summary-band">
        <div><span>商品</span><strong>{productCount}</strong></div>
        <div><span>{filter === "draft" ? "草稿 SKU" : filter === "inactive" ? "非在售 SKU" : "在售 SKU"}</span><strong>{summaryRecords.length}</strong></div>
        <div className={loss ? "is-loss" : ""}><span>预计亏损</span><strong>{loss}</strong></div>
        <div><span>待补全</span><strong>{missing}</strong></div>
        <div><span>实际已核算</span><strong>{actualCount}</strong></div>
        <div><span>平均利润率</span><strong>{(averageMargin * 100).toFixed(2)}%</strong></div>
      </div>

      <div className="pricing-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU、1688、妙手或 TikTok 编号" />
        </label>
        <div className="pricing-filter-tabs" aria-label="筛选商品记录">
          {([['store', `在售 SKU ${storeRecords.length}`], ['loss', `亏损 ${storeLoss}`], ['missing', `缺数据 ${storeMissing}`], ['inactive', `非在售 ${inactiveRecords.length}`], ['draft', `上架草稿 ${draftRecords.length}`]] as const)
            .map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <button className="icon-button" title="刷新" aria-label="刷新利润记录" onClick={() => void load()}><RefreshCw size={16} /></button>
      </div>

      {syncResult && <div className="pricing-sync-result"><Check size={15} /><span>{syncResult}</span></div>}
      {loading && <div className="workflow-empty"><LoaderCircle className="spin" size={20} /><span>正在读取 SKU 利润记录</span></div>}
      {error && <div className="workflow-error"><AlertCircle size={15} /><span>{error}</span></div>}
      {!loading && !error && !records.length && (
        <div className="workflow-empty"><Calculator size={22} /><strong>还没有 SKU 利润记录</strong><span>从任务中心或自然语言发起一次 1688 上架任务后，系统会自动建立记录。</span></div>
      )}
      {!loading && !error && records.length > 0 && visible.length === 0 && (
        <div className="workflow-empty"><Search size={20} /><strong>没有符合条件的 SKU</strong><span>可以切换筛选条件或清空搜索内容。</span></div>
      )}

      {!loading && groups.length > 0 && (
        <div className="pricing-ledger-table-wrap">
          <table className="pricing-ledger-table">
            {groups.map(([key, group]) => {
              const first = group[0];
              const title = first.productTitle || (first.tiktokProductId
                ? `TikTok 商品 ${first.tiktokProductId}`
                : first.sourceItemId ? `1688 商品 ${first.sourceItemId}` : `商品记录 ${key}`);
              const completeGroup = group.filter((record) => record.missingFields.length === 0);
              const profitCny = completeGroup.reduce(
                (sum, record) => sum + record.result.expectedProfitThb / record.input.exchangeRateCnyToThb,
                0,
              );
              const stock = group.reduce((sum, record) => sum + (record.availableStock ?? 0), 0);
              const regularPriceRange = priceRange(group.map((record) => record.input.salePriceThb));
              const activityPriceRange = priceRange(group.flatMap((record) =>
                record.activityPriceThb === undefined ? [] : [record.activityPriceThb]));
              const productStatus = first.tiktokStatus === "INACTIVE" ? "非在售" : first.tiktokProductId ? "在售" : "上架草稿";
              const isCollapsed = collapsed.has(key);
              const isBatchEditing = first.tiktokProductId === batchProductId && batchDraft;
              return (
                <Fragment key={key}>
                  <tbody className="pricing-product-group">
                    <tr className="pricing-product-row">
                      <td colSpan={11}>
                        <div className="pricing-product-overview">
                          <button className="pricing-product-main" onClick={() => toggleGroup(key)}>
                            <span className="pricing-product-chevron">{isCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}</span>
                            <span className="pricing-product-image">
                              {first.productImageUrl ? <img src={first.productImageUrl} alt="" /> : <Package size={24} />}
                            </span>
                            <span className="pricing-product-identity">
                              <span className="pricing-product-badges">
                                <em className={first.tiktokStatus === "INACTIVE" ? "is-inactive" : first.tiktokProductId ? "is-active" : "is-draft"}>{productStatus}</em>
                                {first.categoryName && <em>{first.categoryName}</em>}
                              </span>
                              <strong>{title}</strong>
                              <span className="pricing-product-meta">
                                <span>PID {first.tiktokProductId ?? "待关联"}</span>
                                <span>{group.length} 个 SKU</span>
                              </span>
                            </span>
                          </button>
                          <div className="pricing-product-metrics">
                            <div><span>售价</span><strong>{regularPriceRange}</strong></div>
                            <div><span>活动价</span><strong>{activityPriceRange}</strong></div>
                            <div><span>可售库存</span><strong>{first.tiktokProductId ? stock : "--"}</strong></div>
                            <div><span>成本状态</span><strong>{completeGroup.length}/{group.length} 已完整</strong></div>
                            <div><span>预估利润 CNY</span><strong className={!completeGroup.length || profitCny >= 0 ? "pricing-positive" : "pricing-negative"}>{completeGroup.length ? cny(profitCny) : "待补成本"}</strong></div>
                          </div>
                          {first.tiktokProductId && (
                            <button
                              className={isBatchEditing ? "pricing-batch-button active" : "pricing-batch-button"}
                              aria-label={`批量设置 ${title}`}
                              onClick={() => startBatchEdit(key, first.tiktokProductId!, group)}
                            >
                              {isBatchEditing ? <X size={14} /> : <Settings2 size={14} />}批量成本
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {isBatchEditing && (
                      <tr className="pricing-editor-row pricing-batch-row">
                        <td colSpan={11}>
                          <div className="pricing-inline-editor pricing-batch-editor">
                            <section>
                              <div className="pricing-editor-heading">
                                <div><h3>应用到当前商品全部 {group.length} 个 SKU</h3><p>空白项保持各 SKU 原值；保存后仍可逐个 SKU 修改。</p></div>
                              </div>
                              <div className="pricing-supplier-source">
                                <div className="pricing-supplier-source-heading">
                                  <div>
                                    <span className="pricing-supplier-source-label"><Link2 size={15} />1688 采购来源 <em>选填</em></span>
                                    <p>粘贴 1688 商品链接后，系统会读取供应商 SKU 价格，并匹配到当前商品。</p>
                                  </div>
                                  <button
                                    className="secondary-button pricing-supplier-recognize"
                                    disabled={supplierLoading || !supplierUrl.trim()}
                                    onClick={() => void recognizeSupplierPricing(first.tiktokProductId!)}
                                  >
                                    {supplierLoading ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
                                    {supplierLoading ? "识别中" : "识别采购价"}
                                  </button>
                                </div>
                                <input
                                  type="url"
                                  aria-label="1688 采购链接"
                                  placeholder="https://detail.1688.com/offer/..."
                                  value={supplierUrl}
                                  onChange={(event) => { setSupplierUrl(event.target.value); setSupplierPreview(undefined); }}
                                />
                                {supplierPreview && (
                                  <div className={supplierPreview.matchedCount ? "pricing-supplier-result pricing-supplier-result--success" : "pricing-supplier-result pricing-supplier-result--warning"}>
                                    <div>
                                      <strong>{supplierPreview.sourceTitle}</strong>
                                      <span>1688 商品 {supplierPreview.sourceItemId} · 已匹配 {supplierPreview.matchedCount}/{supplierPreview.targetSkuCount} 个 SKU</span>
                                    </div>
                                    {supplierPreview.requiresConfirmation
                                      ? <span>部分 SKU 无法按名称对应，将按顺序匹配，请确认后再应用。</span>
                                      : supplierPreview.matchedCount
                                        ? <span>采购价会按匹配结果逐个写入 SKU。</span>
                                        : <span>没有找到可确认的对应关系，请手动填写采购价。</span>}
                                  </div>
                                )}
                              </div>
                              <div className="pricing-editor-grid">
                                <label><span>采购价 CNY</span><input autoFocus inputMode="decimal" placeholder="不修改" value={batchDraft.purchasePriceCny} onChange={(event) => changeBatchDraft("purchasePriceCny", event.target.value)} /></label>
                                <label><span>重量 kg</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.weightKg} onChange={(event) => changeBatchDraft("weightKg", event.target.value)} /></label>
                                <label><span>人民币兑泰铢</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.exchangeRateCnyToThb} onChange={(event) => changeBatchDraft("exchangeRateCnyToThb", event.target.value)} /></label>
                                <label><span>国内物流 CNY</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.domesticLogisticsCny} onChange={(event) => changeBatchDraft("domesticLogisticsCny", event.target.value)} /></label>
                                <label><span>云仓 CNY</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.cloudWarehouseCny} onChange={(event) => changeBatchDraft("cloudWarehouseCny", event.target.value)} /></label>
                                <label><span>当地配送 THB</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.buyerLocalDeliveryThb} onChange={(event) => changeBatchDraft("buyerLocalDeliveryThb", event.target.value)} /></label>
                                <label><span>广告 THB</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.advertisingThb} onChange={(event) => changeBatchDraft("advertisingThb", event.target.value)} /></label>
                                <label><span>达人佣金 %</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.creatorCommissionPercent} onChange={(event) => changeBatchDraft("creatorCommissionPercent", event.target.value)} /></label>
                                <label><span>税率 %</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.taxPercent} onChange={(event) => changeBatchDraft("taxPercent", event.target.value)} /></label>
                                <label><span>平台佣金 %</span><input inputMode="decimal" placeholder="不修改" value={batchDraft.categoryCommissionPercent} onChange={(event) => changeBatchDraft("categoryCommissionPercent", event.target.value)} /></label>
                              </div>
                            </section>
                            <div className="pricing-editor-actions">
                              <button className="secondary-button" onClick={stopBatchEdit}><X size={15} />取消</button>
                              <button className="primary-button" disabled={batchSaving} onClick={() => void saveBatch(first.tiktokProductId!, group.length)}>
                                {batchSaving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}应用到 {group.length} 个 SKU
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}

                    {!isCollapsed && (
                      <tr className="pricing-sku-header">
                        <th>SKU 名称</th><th>来源编号</th><th>售价</th><th>活动价</th><th>采购价</th><th>重量</th>
                        <th>预估成本</th><th>预估利润 CNY</th><th>利润率</th><th>实际利润</th><th aria-label="操作" />
                      </tr>
                    )}

                    {!isCollapsed && group.map((record) => {
                      const ready = record.missingFields.length === 0;
                      return (
                        <Fragment key={record.id}>
                          <tr className={ready && !record.result.profitable ? "pricing-row--loss" : ""}>
                            <td><strong>{record.skuName}</strong><small>SKU ID {record.tiktokSkuId ?? record.skuKey}</small></td>
                            <td><strong>{record.sourceItemId ? `1688 ${record.sourceItemId}` : "--"}</strong><small>{record.platformDetailId ? `妙手 ${record.platformDetailId}` : "暂无妙手关联"}</small></td>
                            <td>{money(record.input.salePriceThb)}</td>
                            <td>{record.activityPriceThb === undefined ? "--" : money(record.activityPriceThb)}</td>
                            <td>{record.input.purchasePriceCny.toFixed(2)} CNY</td>
                            <td>{record.input.weightKg} kg</td>
                            <td>{ready ? money(record.result.expectedCostThb) : "--"}</td>
                            <td className={ready ? (record.result.profitable ? "pricing-positive" : "pricing-negative") : ""}>{ready ? cny(record.result.expectedProfitThb / record.input.exchangeRateCnyToThb) : "待补成本"}</td>
                            <td>{ready ? `${(record.result.expectedMargin * 100).toFixed(2)}%` : "--"}</td>
                            <td className={record.actualResult ? (record.actualResult.profitable ? "pricing-positive" : "pricing-negative") : ""}><strong>{record.actualResult ? money(record.actualResult.actualProfitThb) : "待录入"}</strong><small>{record.actualInput?.tiktokSettlementThb === undefined ? "暂无结算" : `结算 ${money(record.actualInput.tiktokSettlementThb)}`}</small></td>
                            <td>
                              <button className="icon-button pricing-edit-button" title="编辑成本与结算" aria-label={`编辑 ${record.skuName}`} onClick={() => editingId === record.id ? stopEdit() : startEdit(record)}>
                                {editingId === record.id ? <X size={15} /> : <Pencil size={15} />}
                              </button>
                            </td>
                          </tr>

                          {editingId === record.id && draft && (
                            <tr className="pricing-editor-row">
                              <td colSpan={11}>
                                <div className="pricing-inline-editor">
                                  <section>
                                    <h3>预估成本（每件）</h3>
                                    <div className="pricing-editor-grid">
                                      <label><span>售价 THB</span><input inputMode="decimal" value={draft.salePriceThb} onChange={(event) => changeDraft("salePriceThb", event.target.value)} /></label>
                                      <label><span>采购价 CNY <em>{sourceText(record, "purchasePriceCny")}</em></span><input inputMode="decimal" value={draft.purchasePriceCny} onChange={(event) => changeDraft("purchasePriceCny", event.target.value)} /></label>
                                      <label><span>重量 kg <em>{sourceText(record, "weightKg")}</em></span><input inputMode="decimal" value={draft.weightKg} onChange={(event) => changeDraft("weightKg", event.target.value)} /></label>
                                      <label><span>人民币兑泰铢 <em>{sourceText(record, "exchangeRateCnyToThb")}</em></span><input inputMode="decimal" value={draft.exchangeRateCnyToThb} onChange={(event) => changeDraft("exchangeRateCnyToThb", event.target.value)} /></label>
                                      <label><span>国内物流 CNY <em>{sourceText(record, "domesticLogisticsCny")}</em></span><input inputMode="decimal" value={draft.domesticLogisticsCny} onChange={(event) => changeDraft("domesticLogisticsCny", event.target.value)} /></label>
                                      <label><span>云仓 CNY <em>{sourceText(record, "cloudWarehouseCny")}</em></span><input inputMode="decimal" value={draft.cloudWarehouseCny} onChange={(event) => changeDraft("cloudWarehouseCny", event.target.value)} /></label>
                                      <label><span>当地配送 THB <em>{sourceText(record, "buyerLocalDeliveryThb")}</em></span><input inputMode="decimal" value={draft.buyerLocalDeliveryThb} onChange={(event) => changeDraft("buyerLocalDeliveryThb", event.target.value)} /></label>
                                      <label><span>广告 THB <em>{sourceText(record, "advertisingThb")}</em></span><input inputMode="decimal" value={draft.advertisingThb} onChange={(event) => changeDraft("advertisingThb", event.target.value)} /></label>
                                      <label><span>达人佣金 % <em>{sourceText(record, "creatorCommissionRate")}</em></span><input inputMode="decimal" value={draft.creatorCommissionPercent} onChange={(event) => changeDraft("creatorCommissionPercent", event.target.value)} /></label>
                                      <label><span>税率 % <em>{sourceText(record, "taxRate")}</em></span><input inputMode="decimal" value={draft.taxPercent} onChange={(event) => changeDraft("taxPercent", event.target.value)} /></label>
                                      <label><span>平台佣金 % <em>{sourceText(record, "categoryCommissionRate")}</em></span><input inputMode="decimal" value={draft.categoryCommissionPercent} onChange={(event) => changeDraft("categoryCommissionPercent", event.target.value)} /></label>
                                    </div>
                                  </section>
                                  <section>
                                    <h3>TikTok 实际结算（累计）</h3>
                                    <div className="pricing-editor-grid pricing-editor-grid--actual">
                                      <label><span>结算月份</span><input type="month" value={draft.period} onChange={(event) => changeDraft("period", event.target.value)} /></label>
                                      <label><span>结算销量</span><input inputMode="numeric" value={draft.soldQuantity} onChange={(event) => changeDraft("soldQuantity", event.target.value)} /></label>
                                      <label><span>实际结算 THB</span><input inputMode="decimal" value={draft.tiktokSettlementThb} onChange={(event) => changeDraft("tiktokSettlementThb", event.target.value)} /></label>
                                      <label><span>物流扣费 THB</span><input inputMode="decimal" value={draft.logisticsDeductionThb} onChange={(event) => changeDraft("logisticsDeductionThb", event.target.value)} /></label>
                                      <label><span>实际广告 THB</span><input inputMode="decimal" value={draft.actualAdvertisingThb} onChange={(event) => changeDraft("actualAdvertisingThb", event.target.value)} /></label>
                                      <label><span>实际达人佣金 THB</span><input inputMode="decimal" value={draft.actualCreatorCommissionThb} onChange={(event) => changeDraft("actualCreatorCommissionThb", event.target.value)} /></label>
                                    </div>
                                  </section>
                                  <div className="pricing-editor-actions">
                                    <button className="secondary-button" onClick={stopEdit}><X size={15} />取消</button>
                                    <button className="primary-button" disabled={saving} onClick={() => void save(record)}>
                                      {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存 SKU
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </Fragment>
              );
            })}
          </table>
        </div>
      )}
    </div>
  );
}
