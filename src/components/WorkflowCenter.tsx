import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  Bot,
  Calculator,
  CircleDollarSign,
  Download,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  GitBranch,
  GripVertical,
  History,
  LayoutTemplate,
  LoaderCircle,
  MessageSquareText,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Store,
  Trash2,
  Users,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  BusinessWorkflowRun,
  DagWorkflowRun,
  FlashSaleWorkflowRun,
  KolOutreachWorkflowRun,
  ProductPublishWorkflowRun,
  PricingDefaults,
  SkuPricingInput,
  WorkflowStatus,
  WorkflowStep,
  WorkflowHistoryItem,
} from "../../shared/contracts";
import { api } from "../api";

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: "准备中",
  running: "执行中",
  waiting_input: "等待补充",
  waiting_confirmation: "等待确认",
  verification_pending: "等待核验",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

const ACTIVE_STATUSES = new Set<WorkflowStatus>(["draft", "running"]);

export type WorkflowTab = "monitor" | "templates" | "builder";
type WorkflowNodeKind = "trigger" | "agent" | "tool" | "condition" | "approval" | "result";

interface BlueprintNode {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  detail: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: BlueprintNode[];
  launch: "product" | "flash" | "chat";
  prompt?: string;
}

const NODE_KIND_META: Record<WorkflowNodeKind, { label: string; icon: LucideIcon }> = {
  trigger: { label: "触发器", icon: Play },
  agent: { label: "Agent", icon: Bot },
  tool: { label: "工具", icon: Wrench },
  condition: { label: "条件", icon: GitBranch },
  approval: { label: "审批", icon: ShieldCheck },
  result: { label: "结果", icon: CheckCircle2 },
};

const NODE_CATALOG: Omit<BlueprintNode, "id">[] = [
  { kind: "trigger", label: "手动发起", detail: "由你点击开始" },
  { kind: "trigger", label: "飞书消息", detail: "收到指定消息后启动" },
  { kind: "agent", label: "选品 Agent", detail: "识别货源并初筛商品" },
  { kind: "agent", label: "定价 Agent", detail: "计算成本、保本价和利润" },
  { kind: "agent", label: "采集 Agent", detail: "采集到妙手公共采集箱" },
  { kind: "agent", label: "上架 Agent", detail: "认领、编辑并发布商品" },
  { kind: "agent", label: "达人 BD Agent", detail: "筛选达人并执行建联" },
  { kind: "condition", label: "利润达标？", detail: "未达标时停止并提醒" },
  { kind: "approval", label: "人工审批", detail: "真实写入前需要确认" },
  { kind: "tool", label: "TikTok Shop", detail: "读取或写入店铺数据" },
  { kind: "tool", label: "妙手 ERP", detail: "采集、认领和发布" },
  { kind: "result", label: "保存 SKU 记录", detail: "记录编号、成本和利润" },
  { kind: "result", label: "飞书通知", detail: "发送结果和异常提醒" },
];

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "supplier-publish",
    name: "1688 商品上架 TikTok",
    description: "从货源读取、利润核算到妙手采集、上架和结果回查。",
    category: "商品",
    launch: "product",
    nodes: [
      { id: "source", kind: "trigger", label: "1688 链接", detail: "手动提交货源" },
      { id: "sourcing", kind: "agent", label: "选品 Agent", detail: "读取货源和 SKU" },
      { id: "pricing", kind: "agent", label: "定价 Agent", detail: "核算利润" },
      { id: "approve", kind: "approval", label: "上架审批", detail: "确认价格和商品资料" },
      { id: "collect", kind: "agent", label: "采集 Agent", detail: "写入妙手" },
      { id: "publish", kind: "agent", label: "上架 Agent", detail: "发布并回查" },
      { id: "record", kind: "result", label: "SKU 台账", detail: "保存商品对应关系" },
    ],
  },
  {
    id: "sku-cost-profit",
    name: "SKU 成本补全与利润计算",
    description: "补全采购、物流、广告和达人佣金，生成可导出的 SKU 利润台账。",
    category: "定价",
    launch: "chat",
    prompt: "查询哪些 SKU 还缺成本，并生成成本补全与利润计算任务",
    nodes: [
      { id: "sync", kind: "tool", label: "同步 TikTok SKU", detail: "读取商品与售价" },
      { id: "cost", kind: "agent", label: "商品管理 Agent", detail: "检查缺失成本" },
      { id: "pricing", kind: "agent", label: "定价 Agent", detail: "重新计算利润" },
      { id: "confirm", kind: "approval", label: "成本确认", detail: "确认默认值和修改值" },
      { id: "ledger", kind: "result", label: "SKU 利润台账", detail: "保存历史并可导出" },
    ],
  },
  {
    id: "loss-price",
    name: "亏损商品识别与改价",
    description: "找出低于保本价的 SKU，生成改价方案，审批后写入 TikTok。",
    category: "定价",
    launch: "chat",
    prompt: "找出所有预计亏损的 SKU，生成改价方案，但在真正改价前先让我审批",
    nodes: [
      { id: "scan", kind: "agent", label: "商品管理 Agent", detail: "扫描 SKU 利润" },
      { id: "loss", kind: "condition", label: "是否亏损？", detail: "对比保本价" },
      { id: "plan", kind: "agent", label: "定价 Agent", detail: "生成建议售价" },
      { id: "approve", kind: "approval", label: "改价审批", detail: "逐项展示前后价格" },
      { id: "write", kind: "tool", label: "TikTok 改价", detail: "写入后回查" },
    ],
  },
  {
    id: "flash-sale",
    name: "TikTok 秒杀活动",
    description: "检查商品、SKU 和库存，审批后创建秒杀并核验结果。",
    category: "促销",
    launch: "flash",
    nodes: [
      { id: "input", kind: "trigger", label: "活动参数", detail: "商品、时间和活动价" },
      { id: "check", kind: "tool", label: "检查 SKU 库存", detail: "读取 TikTok 实时数据" },
      { id: "approve", kind: "approval", label: "活动审批", detail: "确认价格和限购" },
      { id: "create", kind: "tool", label: "创建秒杀", detail: "创建并绑定 SKU" },
      { id: "verify", kind: "result", label: "核验活动", detail: "确认平台已生效" },
    ],
  },
  {
    id: "kol-outreach",
    name: "达人筛选与批量建联",
    description: "按品类和粉丝条件筛选达人，确认佣金后执行建联并回查结果。",
    category: "达人",
    launch: "chat",
    prompt: "创建一个达人筛选和批量建联任务，先让我确认筛选条件、佣金和邀请数量",
    nodes: [
      { id: "goal", kind: "trigger", label: "建联目标", detail: "品类、粉丝与数量" },
      { id: "match", kind: "agent", label: "达人 BD Agent", detail: "筛选和锁定达人" },
      { id: "approve", kind: "approval", label: "建联审批", detail: "确认佣金、话术和名单" },
      { id: "send", kind: "tool", label: "批量建联", detail: "通过达人工具执行" },
      { id: "result", kind: "result", label: "建联结果", detail: "记录成功、失败与跳过" },
    ],
  },
];

function stepIcon(step: WorkflowStep) {
  if (step.status === "completed") return <Check size={14} />;
  if (step.status === "running") return <LoaderCircle className="spin" size={14} />;
  if (step.status === "failed") return <AlertCircle size={14} />;
  return <Circle size={12} />;
}

function shortDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function readableWarning(value: string): string {
  return value.replace(/妙手 API \S+ 业务错误: /g, "妙手提示：").replace("应用无权限访问该接口", "当前妙手应用没有开通此能力");
}

function readableError(value: string): string {
  if (/shopCollectItemInfo\.package(?:Length|Width|Height)\s*不能小于1/i.test(value)) {
    return "包裹长、宽、高未填写或小于 1 厘米，请补充实际尺寸后重新生成编辑预览。";
  }
  return readableWarning(value);
}

function Progress({ steps }: { steps: WorkflowStep[] }) {
  return (
    <div className="workflow-steps" aria-label="任务进度">
      {steps.map((step) => (
        <div className={`workflow-step workflow-step--${step.status}`} key={step.id}>
          <span className="workflow-step-dot">{stepIcon(step)}</span>
          <div><strong>{step.label}</strong>{step.detail && <span>{step.detail}</span>}</div>
        </div>
      ))}
    </div>
  );
}

function RunMessages({ run, localError }: { run: BusinessWorkflowRun; localError?: string }) {
  const summary = "summary" in run ? run.summary : undefined;
  const warnings = "warnings" in run ? run.warnings : [];
  return (
    <>
      {summary && <p className="workflow-summary">{summary}</p>}
      {warnings.length > 0 && <div className="workflow-warning"><AlertCircle size={15} /><ul>{warnings.map((warning) => <li key={warning}>{readableWarning(warning)}</li>)}</ul></div>}
      {(run.error || localError) && <div className="workflow-error"><AlertCircle size={15} /><span>{readableError(localError ?? run.error ?? "")}</span></div>}
    </>
  );
}

function RunHeader({ run, icon, meta }: { run: BusinessWorkflowRun; icon: React.ReactNode; meta: string }) {
  return (
    <header className="workflow-run-header">
      <div className="workflow-run-title"><span className="workflow-run-icon">{icon}</span><div><strong>{run.title}</strong><span>{meta} · {shortDate(run.createdAt)}</span></div></div>
      <span className={`workflow-status workflow-status--${run.status}`}>
        {run.status === "running" && <LoaderCircle className="spin" size={13} />}
        {run.status === "completed" && <CheckCircle2 size={13} />}
        {STATUS_LABELS[run.status]}
      </span>
    </header>
  );
}

function WorkflowHistory({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<WorkflowHistoryItem[]>();
  const [error, setError] = useState<string>();
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (events) return;
    try { setEvents((await api.workflowHistory(runId)).events); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "执行记录读取失败。"); }
  };
  return (
    <div className="workflow-history">
      <button className="workflow-history-toggle" onClick={() => void toggle()}><History size={14} />{open ? "收起执行记录" : "查看执行记录"}</button>
      {open && <div className="workflow-history-list">
        {!events && !error && <span><LoaderCircle className="spin" size={14} />正在读取执行记录</span>}
        {error && <span className="workflow-history-error">{error}</span>}
        {events?.map((event) => {
          const step = event.stepId && "steps" in event.snapshot ? event.snapshot.steps.find((item) => item.id === event.stepId) : undefined;
          return <div key={event.id}><time>{shortDate(event.createdAt)}</time><strong>{step?.label ?? (event.eventType === "created" ? "创建任务" : event.eventType === "migrated" ? "迁移旧任务" : "更新任务")}</strong><span>{event.error ?? event.detail ?? STATUS_LABELS[event.snapshot.status]}</span></div>;
        })}
      </div>}
    </div>
  );
}

interface RunCardProps<T extends BusinessWorkflowRun> {
  initialRun: T;
  onChange?: (run: BusinessWorkflowRun) => void;
  compact?: boolean;
}

function money(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "--";
}

function PricingCard({
  run,
  editable,
  busy,
  onSubmit,
}: {
  run: ProductPublishWorkflowRun;
  editable: boolean;
  busy: boolean;
  onSubmit: (input: { defaults: Partial<PricingDefaults>; skus: Array<{ skuKey: string; values: Partial<SkuPricingInput> }>; removedSkuKeys: string[] }) => void;
}) {
  const records = run.pricingSkus ?? [];
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ active: false, pointerId: -1, startX: 0, scrollLeft: 0 });
  const [dragging, setDragging] = useState(false);
  const [removedSkuKeys, setRemovedSkuKeys] = useState<Set<string>>(() => new Set());
  const [defaults, setDefaults] = useState(() => ({
    exchangeRateCnyToThb: String(run.pricingDefaults?.exchangeRateCnyToThb ?? 4.8503),
    domesticLogisticsCny: String(run.pricingDefaults?.domesticLogisticsCny ?? 2.5),
    cloudWarehouseCny: String(run.pricingDefaults?.cloudWarehouseCny ?? 1.5),
    buyerLocalDeliveryThb: String(run.pricingDefaults?.buyerLocalDeliveryThb ?? 79),
    advertisingThb: String(run.pricingDefaults?.advertisingThb ?? 0),
    creatorCommissionPercent: String((run.pricingDefaults?.creatorCommissionRate ?? 0) * 100),
  }));
  const [skuValues, setSkuValues] = useState(() => Object.fromEntries(records.map((record) => [record.skuKey, {
    salePriceThb: String(record.input.salePriceThb),
    purchasePriceCny: String(record.input.purchasePriceCny),
    weightKg: String(record.input.weightKg),
    taxPercent: String(record.input.taxRate * 100),
    commissionPercent: String(record.input.categoryCommissionRate * 100),
  }])));

  useEffect(() => {
    setRemovedSkuKeys(new Set());
    setDefaults({
      exchangeRateCnyToThb: String(run.pricingDefaults?.exchangeRateCnyToThb ?? 4.8503),
      domesticLogisticsCny: String(run.pricingDefaults?.domesticLogisticsCny ?? 2.5),
      cloudWarehouseCny: String(run.pricingDefaults?.cloudWarehouseCny ?? 1.5),
      buyerLocalDeliveryThb: String(run.pricingDefaults?.buyerLocalDeliveryThb ?? 79),
      advertisingThb: String(run.pricingDefaults?.advertisingThb ?? 0),
      creatorCommissionPercent: String((run.pricingDefaults?.creatorCommissionRate ?? 0) * 100),
    });
    setSkuValues(Object.fromEntries(records.map((record) => [record.skuKey, {
      salePriceThb: String(record.input.salePriceThb),
      purchasePriceCny: String(record.input.purchasePriceCny),
      weightKg: String(record.input.weightKg),
      taxPercent: String(record.input.taxRate * 100),
      commissionPercent: String(record.input.categoryCommissionRate * 100),
    }])));
  }, [run.updatedAt]);

  if (!records.length) return null;
  const visibleRecords = records.filter((record) => !removedSkuKeys.has(record.skuKey));
  const changeDefault = (field: keyof typeof defaults, value: string) => setDefaults((current) => ({ ...current, [field]: value }));
  const changeSku = (skuKey: string, field: string, value: string) => setSkuValues((current) => ({
    ...current,
    [skuKey]: { ...current[skuKey], [field]: value },
  }));
  const submit = () => onSubmit({
    defaults: {
      exchangeRateCnyToThb: Number(defaults.exchangeRateCnyToThb),
      domesticLogisticsCny: Number(defaults.domesticLogisticsCny),
      cloudWarehouseCny: Number(defaults.cloudWarehouseCny),
      buyerLocalDeliveryThb: Number(defaults.buyerLocalDeliveryThb),
      advertisingThb: Number(defaults.advertisingThb),
      creatorCommissionRate: Number(defaults.creatorCommissionPercent) / 100,
    },
    skus: visibleRecords.map((record) => ({
      skuKey: record.skuKey,
      values: {
        salePriceThb: Number(skuValues[record.skuKey]?.salePriceThb),
        purchasePriceCny: Number(skuValues[record.skuKey]?.purchasePriceCny),
        weightKg: Number(skuValues[record.skuKey]?.weightKg),
        taxRate: Number(skuValues[record.skuKey]?.taxPercent) / 100,
        categoryCommissionRate: Number(skuValues[record.skuKey]?.commissionPercent) / 100,
      },
    })),
    removedSkuKeys: [...removedSkuKeys],
  });
  const removeSku = (skuKey: string) => {
    if (visibleRecords.length <= 1) return;
    setRemovedSkuKeys((current) => new Set([...current, skuKey]));
  };
  const startTableDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, a")) return;
    const element = tableWrapRef.current;
    if (!element || element.scrollWidth <= element.clientWidth) return;
    dragState.current = { active: true, pointerId: event.pointerId, startX: event.clientX, scrollLeft: element.scrollLeft };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  };
  const moveTableDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = tableWrapRef.current;
    if (!element || !dragState.current.active || dragState.current.pointerId !== event.pointerId) return;
    element.scrollLeft = dragState.current.scrollLeft - (event.clientX - dragState.current.startX);
  };
  const stopTableDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = tableWrapRef.current;
    if (!dragState.current.active || dragState.current.pointerId !== event.pointerId) return;
    dragState.current.active = false;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  return (
    <section className={`pricing-card ${editable ? "pricing-card--editable" : ""}`}>
      <div className="pricing-card-heading">
        <div><span className="pricing-card-icon"><Calculator size={16} /></span><div><strong>SKU 成本与预估利润</strong><span>按每个 SKU 单独记录，可修改并留存历史</span></div></div>
        {run.pricingSummary && <div className={`pricing-health ${run.pricingSummary.lossSkus ? "pricing-health--loss" : "pricing-health--ok"}`}><b>{visibleRecords.filter((record) => !record.result.profitable).length}</b><span>亏损 SKU</span></div>}
      </div>
      <div className="pricing-default-grid">
        <label><span>人民币兑泰铢</span><input disabled={!editable} inputMode="decimal" value={defaults.exchangeRateCnyToThb} onChange={(event) => changeDefault("exchangeRateCnyToThb", event.target.value)} /></label>
        <label><span>国内物流（CNY/件）</span><input disabled={!editable} inputMode="decimal" value={defaults.domesticLogisticsCny} onChange={(event) => changeDefault("domesticLogisticsCny", event.target.value)} /></label>
        <label><span>云仓（CNY/件）</span><input disabled={!editable} inputMode="decimal" value={defaults.cloudWarehouseCny} onChange={(event) => changeDefault("cloudWarehouseCny", event.target.value)} /></label>
        <label><span>当地配送（THB/件）</span><input disabled={!editable} inputMode="decimal" value={defaults.buyerLocalDeliveryThb} onChange={(event) => changeDefault("buyerLocalDeliveryThb", event.target.value)} /></label>
        <label><span>广告（THB/件）</span><input disabled={!editable} inputMode="decimal" value={defaults.advertisingThb} onChange={(event) => changeDefault("advertisingThb", event.target.value)} /></label>
        <label><span>达人佣金（%）</span><input disabled={!editable} inputMode="decimal" value={defaults.creatorCommissionPercent} onChange={(event) => changeDefault("creatorCommissionPercent", event.target.value)} /></label>
      </div>
      <div
        className={`pricing-table-wrap ${dragging ? "is-dragging" : ""}`}
        ref={tableWrapRef}
        onPointerDown={startTableDrag}
        onPointerMove={moveTableDrag}
        onPointerUp={stopTableDrag}
        onPointerCancel={stopTableDrag}
      ><table className="pricing-table"><thead><tr><th>SKU</th><th>售价 THB</th><th>采购 CNY</th><th>重量 kg</th><th>税率</th><th>平台佣金</th><th>预估利润</th><th>利润率</th><th>保本售价</th>{editable && <th>操作</th>}</tr></thead><tbody>
        {visibleRecords.map((record) => <tr className={record.result.profitable ? "" : "pricing-row--loss"} key={record.skuKey}>
          <td><strong>{record.skuName}</strong><small>{record.fieldSources.purchasePriceCny === "1688" ? "采购价来自 1688" : "需人工核对"}</small></td>
          <td>{editable ? <input inputMode="decimal" value={skuValues[record.skuKey]?.salePriceThb ?? ""} onChange={(event) => changeSku(record.skuKey, "salePriceThb", event.target.value)} /> : money(record.input.salePriceThb)}</td>
          <td>{editable ? <input inputMode="decimal" value={skuValues[record.skuKey]?.purchasePriceCny ?? ""} onChange={(event) => changeSku(record.skuKey, "purchasePriceCny", event.target.value)} /> : money(record.input.purchasePriceCny)}</td>
          <td>{editable ? <input inputMode="decimal" value={skuValues[record.skuKey]?.weightKg ?? ""} onChange={(event) => changeSku(record.skuKey, "weightKg", event.target.value)} /> : record.input.weightKg}</td>
          <td>{editable ? <input inputMode="decimal" value={skuValues[record.skuKey]?.taxPercent ?? ""} onChange={(event) => changeSku(record.skuKey, "taxPercent", event.target.value)} /> : percent(record.input.taxRate)}</td>
          <td>{editable ? <input inputMode="decimal" value={skuValues[record.skuKey]?.commissionPercent ?? ""} onChange={(event) => changeSku(record.skuKey, "commissionPercent", event.target.value)} /> : percent(record.input.categoryCommissionRate)}</td>
          <td className={record.result.profitable ? "pricing-positive" : "pricing-negative"}>{money(record.result.expectedProfitThb)}</td>
          <td>{percent(record.result.expectedMargin)}</td><td>{money(record.result.breakEvenPriceThb)}</td>
          {editable && <td><button className="pricing-sku-remove" disabled={visibleRecords.length <= 1} title="从待发布商品中移除" aria-label={`移除 ${record.skuName}`} onClick={() => removeSku(record.skuKey)}><Trash2 size={15} /></button></td>}
        </tr>)}
      </tbody></table></div>
      {editable && removedSkuKeys.size > 0 && <div className="pricing-sku-removal-notice"><span>将保留 {visibleRecords.length} 个 SKU，移除 {removedSkuKeys.size} 个。保存后才会应用到妙手。</span><button onClick={() => setRemovedSkuKeys(new Set())}><RotateCcw size={14} />撤销删减</button></div>}
      <div className="pricing-card-footer"><span>{editable ? "表格可以左右拖动。保存后会重新计算，并把SKU删减加入妙手编辑预览。" : "当前显示的是预估利润；实际结算接入后会另存实际利润。"}</span><div><a className="secondary-button" href={`/api/pricing/export.xlsx?workflowId=${encodeURIComponent(run.id)}`} download><Download size={15} />导出 Excel</a>{editable && <button className="primary-button" disabled={busy} onClick={submit}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存 {visibleRecords.length} 个 SKU</button>}</div></div>
    </section>
  );
}

function ProductRunCard({ initialRun, onChange, compact = false }: RunCardProps<ProductPublishWorkflowRun>) {
  const [run, setRun] = useState(initialRun);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [price, setPrice] = useState(run.publishPrice ? String(run.publishPrice) : "");
  const [dimensions, setDimensions] = useState({
    length: run.packageDimensions ? String(run.packageDimensions.length) : "",
    width: run.packageDimensions ? String(run.packageDimensions.width) : "",
    height: run.packageDimensions ? String(run.packageDimensions.height) : "",
  });
  const publishSubmitted = run.steps.find((step) => step.id === "publish")?.status === "completed";

  useEffect(() => {
    setRun(initialRun);
    if (initialRun.publishPrice) setPrice(String(initialRun.publishPrice));
    if (initialRun.packageDimensions) setDimensions({
      length: String(initialRun.packageDimensions.length),
      width: String(initialRun.packageDimensions.width),
      height: String(initialRun.packageDimensions.height),
    });
  }, [initialRun]);
  const replaceRun = (next: BusinessWorkflowRun) => {
    if (next.type !== "product_publish") return;
    setRun(next);
    onChange?.(next);
  };
  useEffect(() => {
    // waiting_confirmation 时也轮询（与 DAG 卡一致）：聊天里的卡片是静态快照，
    // 不轮询会永远停在旧状态；busy 期间轮询覆盖 approve/retry 长链路执行期
    if (!ACTIVE_STATUSES.has(run.status) && run.status !== "waiting_confirmation" && !busy) return;
    const timer = window.setInterval(() => { void api.workflow(run.id).then(({ run: next }) => replaceRun(next)).catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [run.id, run.status, busy]);

  const act = async (name: string, operation: () => Promise<{ run: BusinessWorkflowRun }>) => {
    setBusy(name); setError(undefined);
    try { replaceRun((await operation()).run); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "操作失败，请重试。"); }
    finally { setBusy(undefined); }
  };

  const submitProductInput = () => {
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) { setError("请输入大于 0 的发布售价。"); return; }
    const values = Object.values(dimensions);
    if (values.some(Boolean) && !values.every((value) => Number(value) >= 1)) { setError("尺寸要么不填，要么完整填写长、宽、高，并且每项至少为 1 厘米。"); return; }
    const packageDimensions = values.every(Boolean)
      ? { length: Number(dimensions.length), width: Number(dimensions.width), height: Number(dimensions.height) }
      : undefined;
    void act("product-input", () => api.updateWorkflowProductInput(run.id, { publishPrice: numericPrice, packageDimensions }));
  };

  return (
    <article className={`workflow-run workflow-run--${run.status} ${compact ? "workflow-run--compact" : ""}`}>
      <RunHeader run={run} icon={<PackageCheck size={18} />} meta={run.shopName ? `${run.shopName}${run.shopSite ? ` · ${run.shopSite}` : ""}` : "目标店铺待确定"} />
      <a className="workflow-source" href={run.sourceUrl} target="_blank" rel="noreferrer"><span>{run.sourceUrl}</span><ExternalLink size={13} /></a>
      <Progress steps={run.steps} />
      <RunMessages run={run} localError={error} />

      {run.pricingSkus?.length ? <PricingCard run={run} editable={!publishSubmitted && run.steps.find((step) => step.id === "edit")?.status !== "completed" && !new Set<WorkflowStatus>(["running", "completed", "cancelled", "verification_pending"]).has(run.status)} busy={busy === "pricing"} onSubmit={(input) => void act("pricing", () => api.updateWorkflowPricing(run.id, input))} /> : null}

      {run.requiredInput?.kind === "shop" && (
        <div className="workflow-input-block"><strong><Store size={15} />{run.requiredInput.prompt}</strong><div className="workflow-shop-options">
          {run.requiredInput.options.map((shop) => <button className="secondary-button" disabled={Boolean(busy)} key={shop.id} onClick={() => void act(`shop-${shop.id}`, () => api.selectWorkflowShop(run.id, shop.id))}>{busy === `shop-${shop.id}` ? <LoaderCircle className="spin" size={15} /> : <Store size={15} />}{shop.name}<span>{shop.site}</span></button>)}
        </div></div>
      )}

      {run.requiredInput?.kind === "product_edit" && (
        <div className="workflow-input-block workflow-product-input"><strong>{run.requiredInput.prompt}</strong>
          <label><span>发布售价</span><input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="例如 999" /></label>
          <div className="workflow-dimension-row"><label><span>长（cm，至少1）</span><input inputMode="decimal" min="1" value={dimensions.length} onChange={(event) => setDimensions((value) => ({ ...value, length: event.target.value }))} /></label><label><span>宽（cm，至少1）</span><input inputMode="decimal" min="1" value={dimensions.width} onChange={(event) => setDimensions((value) => ({ ...value, width: event.target.value }))} /></label><label><span>高（cm，至少1）</span><input inputMode="decimal" min="1" value={dimensions.height} onChange={(event) => setDimensions((value) => ({ ...value, height: event.target.value }))} /></label></div>
          <button className="primary-button" disabled={Boolean(busy)} onClick={submitProductInput}>{busy === "product-input" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}生成编辑预览</button>
        </div>
      )}

      {run.requiredInput?.kind === "product_data" && <div className="workflow-input-block workflow-input-block--issues"><strong><AlertCircle size={15} />{run.requiredInput.prompt}</strong><ul>{run.requiredInput.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul><button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("readiness", () => api.recheckWorkflowReadiness(run.id))}>{busy === "readiness" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}补全后重新检查</button></div>}

      {run.editPreview && run.confirmationKind === "product_edit" && <div className="workflow-change-preview"><strong>本次会保存这些变化</strong>{run.editPreview.changes.map((change) => <div key={change.field}><span>{change.field}</span><small>{change.before}</small><Check size={13} /><b>{change.after}</b></div>)}</div>}

      <WorkflowHistory runId={run.id} />

      <div className="workflow-actions">
        {run.status === "waiting_confirmation" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("approve", () => api.approveWorkflow(run.id))}>{busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{run.confirmationKind === "workflow_start" ? "审核并开始采集" : run.confirmationKind === "product_edit" ? "审核并保存到妙手" : `审核并发布到 ${run.shopName ?? "目标店铺"}`}</button>}
        {run.status === "failed" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("retry", () => api.retryWorkflow(run.id))}>{busy === "retry" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}重试失败步骤</button>}
        {run.status === "verification_pending" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("verify", () => api.verifyWorkflow(run.id))}>{busy === "verify" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}重新核验发布结果</button>}
        {!publishSubmitted && !new Set<WorkflowStatus>(["completed", "cancelled"]).has(run.status) && <button className="secondary-button" disabled={Boolean(busy) || run.status === "running"} onClick={() => void act("cancel", () => api.cancelWorkflow(run.id))}><Ban size={15} />取消任务</button>}
      </div>
    </article>
  );
}

function FlashSaleRunCard({ initialRun, onChange, compact = false }: RunCardProps<FlashSaleWorkflowRun>) {
  const [run, setRun] = useState(initialRun);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setRun(initialRun); }, [initialRun]);
  const replaceRun = (next: BusinessWorkflowRun) => { if (next.type === "flash_sale") { setRun(next); onChange?.(next); } };
  useEffect(() => {
    // waiting_confirmation 时也轮询（与 DAG 卡一致）：聊天里的卡片是静态快照，
    // 不轮询会永远停在旧状态；busy 期间轮询覆盖 approve/retry 长链路执行期
    if (!ACTIVE_STATUSES.has(run.status) && run.status !== "waiting_confirmation" && !busy) return;
    const timer = window.setInterval(() => { void api.workflow(run.id).then(({ run: next }) => replaceRun(next)).catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [run.id, run.status, busy]);
  const act = async (name: string, operation: () => Promise<{ run: BusinessWorkflowRun }>) => {
    setBusy(name); setError(undefined);
    try { replaceRun((await operation()).run); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "操作失败，请重试。"); }
    finally { setBusy(undefined); }
  };
  return (
    <article className={`workflow-run workflow-run--${run.status} ${compact ? "workflow-run--compact" : ""}`}>
      <RunHeader run={run} icon={<Zap size={18} />} meta={run.shopName ? `${run.shopName} · ${run.shopRegion ?? ""}` : "TikTok 店铺"} />
      <div className="workflow-facts"><span>商品 <b>{run.productTitle ?? run.productId}</b></span><span>活动价 <b>{run.priceAmount} {run.currency}</b></span><span>时间 <b>{shortDate(run.startAt)} - {shortDate(run.endAt)}</b></span><span>SKU <b>{run.selectedSkus.length || "待检查"}</b></span>{run.activityId && <span>活动 ID <b>{run.activityId}</b></span>}</div>
      <Progress steps={run.steps} />
      <RunMessages run={run} localError={error} />
      <WorkflowHistory runId={run.id} />
      <div className="workflow-actions">
        {run.status === "waiting_confirmation" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("approve", () => api.approveWorkflow(run.id))}>{busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <Zap size={16} />}审核并创建秒杀</button>}
        {run.status === "failed" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("retry", () => api.retryWorkflow(run.id))}>{busy === "retry" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{run.activityId ? "重试绑定商品" : "重新检查"}</button>}
        {run.status === "verification_pending" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("verify", () => api.verifyWorkflow(run.id))}>{busy === "verify" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}重新核验活动</button>}
        {!run.activityId && !new Set<WorkflowStatus>(["completed", "cancelled"]).has(run.status) && <button className="secondary-button" disabled={Boolean(busy) || run.status === "running"} onClick={() => void act("cancel", () => api.cancelWorkflow(run.id))}><Ban size={15} />取消任务</button>}
      </div>
    </article>
  );
}

function KolRunCard({ initialRun, onChange, compact = false }: RunCardProps<KolOutreachWorkflowRun>) {
  const [run, setRun] = useState(initialRun);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setRun(initialRun); }, [initialRun]);
  const replaceRun = (next: BusinessWorkflowRun) => {
    if (next.type !== "kol_outreach") return;
    setRun(next);
    onChange?.(next);
  };
  useEffect(() => {
    // waiting_confirmation 时也轮询（与 DAG 卡一致）：聊天里的卡片是静态快照，
    // 不轮询会永远停在旧状态；busy 期间轮询覆盖 approve/retry 长链路执行期
    if (!ACTIVE_STATUSES.has(run.status) && run.status !== "waiting_confirmation" && !busy) return;
    const timer = window.setInterval(() => { void api.workflow(run.id).then(({ run: next }) => replaceRun(next)).catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [run.id, run.status, busy]);
  const act = async (name: string, operation: () => Promise<{ run: BusinessWorkflowRun }>) => {
    setBusy(name); setError(undefined);
    try { replaceRun((await operation()).run); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "操作失败，请重试。"); }
    finally { setBusy(undefined); }
  };
  const executionStarted = Boolean(run.steps.find((step) => step.id === "execute")?.startedAt);
  const selectedCreators = run.matchedCreators.filter((creator) => run.selectedCreatorIds.includes(creator.id));
  return (
    <article className={`workflow-run workflow-run--${run.status} ${compact ? "workflow-run--compact" : ""}`}>
      <RunHeader run={run} icon={<Users size={18} />} meta={run.filters.category ? `${run.filters.category} 达人` : "TikTok 达人"} />
      <div className="workflow-facts">
        <span>建联目标 <b>{run.totalTarget} 位</b></span>
        <span>佣金 <b>{run.commissionRate}%</b></span>
        <span>每批 <b>{run.batchSize} 位</b></span>
        {run.filters.minFollowers && <span>最低粉丝 <b>{run.filters.minFollowers.toLocaleString("zh-CN")}</b></span>}
        <span>免费样品 <b>{run.freeSample ? "提供" : "不提供"}</b></span>
      </div>
      {selectedCreators.length > 0 && <div className="kol-run-creators">
        <strong>已锁定达人</strong>
        <div>{selectedCreators.slice(0, 5).map((creator) => <span key={creator.id}>{creator.nickname}<small>{creator.followerCount.toLocaleString("zh-CN")} 粉丝</small></span>)}</div>
        {selectedCreators.length > 5 && <small>还有 {selectedCreators.length - 5} 位</small>}
      </div>}
      {run.result && <div className="kol-run-result"><span>成功 <b>{run.result.success}</b></span><span>失败 <b>{run.result.failed}</b></span><span>跳过 <b>{run.result.skipped}</b></span></div>}
      <Progress steps={run.steps} />
      <RunMessages run={run} localError={error} />
      {run.requiredInput && <div className="workflow-input-block"><strong><AlertCircle size={15} />{run.requiredInput.prompt}</strong></div>}
      <WorkflowHistory runId={run.id} />
      <div className="workflow-actions">
        {run.status === "waiting_confirmation" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("approve", () => api.approveWorkflow(run.id))}>{busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}审核并发送 {run.totalTarget} 位</button>}
        {(run.status === "waiting_input" || (run.status === "failed" && !executionStarted)) && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("retry", () => api.retryWorkflow(run.id))}>{busy === "retry" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}重新检查</button>}
        {run.status === "verification_pending" && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("verify", () => api.verifyWorkflow(run.id))}>{busy === "verify" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}核对插件记录</button>}
        {!executionStarted && !new Set<WorkflowStatus>(["completed", "cancelled", "running"]).has(run.status) && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void act("cancel", () => api.cancelWorkflow(run.id))}><Ban size={15} />取消任务</button>}
      </div>
    </article>
  );
}

function DagRunCard({ initialRun, onChange, compact = false }: RunCardProps<DagWorkflowRun>) {
  const [run, setRun] = useState<DagWorkflowRun>(initialRun);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setRun(initialRun); }, [initialRun]);

  const replaceRun = (next: BusinessWorkflowRun) => {
    if (next.type !== "dag") return;
    setRun(next);
    onChange?.(next);
  };
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(run.status) && run.status !== "waiting_confirmation" && !busy) return;
    const timer = window.setInterval(() => { void api.workflow(run.id).then(({ run: next }) => replaceRun(next)).catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [run.id, run.status, busy]);

  const act = async (name: string, operation: () => Promise<{ run: BusinessWorkflowRun }>) => {
    setBusy(name); setError(undefined);
    try { replaceRun((await operation()).run); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "操作失败，请重试。"); }
    finally { setBusy(undefined); }
  };

  const nodeLabel = (id: string) => run.definition.nodes.find((node) => node.id === id)?.label ?? id;

  return (
    <article className="workflow-run workflow-run--dag">
      <RunHeader run={run} icon={<Workflow size={18} />} meta="DAG 工作流" />
      {run.result?.summary && <p className="workflow-summary">{run.result.summary}</p>}
      <RunMessages run={run} localError={error} />
      {run.status === "waiting_confirmation" && run.pendingConfirmation?.prompt && (
        <div className="workflow-confirmation-prompt">{run.pendingConfirmation.prompt}</div>
      )}
      <div className="workflow-nodes" aria-label="节点进度">
        {run.nodeStates.map((node) => (
          <div className={`workflow-node workflow-node--${node.state}`} key={node.id}>
            <span className="workflow-node-dot" />
            <div>
              <strong>{nodeLabel(node.id)}</strong>
              {node.detail && <span>{node.detail}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="workflow-actions">
        {run.status === "waiting_confirmation" && (
          <button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("approve", () => api.approveWorkflow(run.id))}>
            {busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}审核并发布
          </button>
        )}
        {!(run.status === "completed" || run.status === "cancelled" || run.status === "running") && (
          <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void act("cancel", () => api.cancelWorkflow(run.id))}>
            <Ban size={15} />取消任务
          </button>
        )}
      </div>
      <WorkflowHistory runId={run.id} />
    </article>
  );
}

export function WorkflowRunCard({ initialRun, onChange, compact = false }: RunCardProps<BusinessWorkflowRun>) {
  if (initialRun.type === "flash_sale") return <FlashSaleRunCard initialRun={initialRun} onChange={onChange} compact={compact} />;
  if (initialRun.type === "kol_outreach") return <KolRunCard initialRun={initialRun} onChange={onChange} compact={compact} />;
  if (initialRun.type === "dag") return <DagRunCard initialRun={initialRun} onChange={onChange} compact={compact} />;
  return <ProductRunCard initialRun={initialRun} onChange={onChange} compact={compact} />;
}

export function WorkflowArtifact({ initialRun }: { initialRun: BusinessWorkflowRun }) {
  return <section className="artifact workflow-artifact"><WorkflowRunCard initialRun={initialRun} compact /></section>;
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

interface WorkflowCenterProps {
  activeTab: WorkflowTab;
  onTabChange: (tab: WorkflowTab) => void;
  onOpenChat: (prompt?: string) => void;
}

const SAVED_WORKFLOWS_KEY = "cyberfleet.workflow.templates";

function readSavedTemplates(): WorkflowTemplate[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SAVED_WORKFLOWS_KEY) ?? "[]") as WorkflowTemplate[];
    return Array.isArray(stored) ? stored.filter((item) => item.id?.startsWith("custom-") && Array.isArray(item.nodes)) : [];
  } catch {
    return [];
  }
}

function workflowTypeLabel(run: BusinessWorkflowRun): string {
  if (run.type === "product_publish") return "商品上架";
  if (run.type === "flash_sale") return "秒杀活动";
  return "达人建联";
}

function currentStepLabel(run: BusinessWorkflowRun): string {
  if (run.type === "dag") {
    const active = run.nodeStates.find((node) => node.state === "running")
      ?? run.nodeStates.find((node) => node.state === "failed")
      ?? run.nodeStates.find((node) => node.state === "pending");
    return (active ? run.definition.nodes.find((node) => node.id === active.id)?.label ?? active.id : undefined) ?? "已结束";
  }
  return run.steps.find((step) => step.status === "running")?.label
    ?? run.steps.find((step) => step.status === "failed")?.label
    ?? run.steps.find((step) => step.status === "pending")?.label
    ?? "已结束";
}

export function WorkflowCenter({ activeTab, onTabChange, onOpenChat }: WorkflowCenterProps) {
  const [mode, setMode] = useState<"product" | "flash">("product");
  const [runs, setRuns] = useState<BusinessWorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [showLauncher, setShowLauncher] = useState(false);
  const [runFilter, setRunFilter] = useState<"all" | "active" | "attention" | "completed">("all");
  const [runQuery, setRunQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>();
  const [savedTemplates, setSavedTemplates] = useState(readSavedTemplates);
  const [builderName, setBuilderName] = useState("新工作流");
  const [builderNodes, setBuilderNodes] = useState<BlueprintNode[]>(() => WORKFLOW_TEMPLATES[0].nodes.map((node) => ({ ...node })));
  const [selectedNodeId, setSelectedNodeId] = useState(WORKFLOW_TEMPLATES[0].nodes[0].id);
  const [draggedNodeIndex, setDraggedNodeIndex] = useState<number>();
  const [saveNotice, setSaveNotice] = useState<string>();
  const [product, setProduct] = useState({ sourceUrl: "", price: "", length: "", width: "", height: "" });
  const defaultStart = useMemo(() => new Date(Date.now() + 2 * 60 * 60 * 1000), []);
  const [flash, setFlash] = useState({ productId: "", title: "", startAt: localDateTimeValue(defaultStart), endAt: localDateTimeValue(new Date(defaultStart.getTime() + 8 * 60 * 60 * 1000)), price: "", currency: "THB", quantity: "99", perUser: "20" });

  useEffect(() => {
    let active = true;
    const load = () => void api.workflows().then((result) => {
      if (!active) return;
      setRuns(result.runs);
      setSelectedRunId((current) => current && result.runs.some((run) => run.id === current) ? current : result.runs[0]?.id);
      setLastUpdatedAt(new Date());
    }).catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : "任务记录读取失败。"); }).finally(() => { if (active) setLoading(false); });
    load();
    const timer = window.setInterval(load, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const counts = useMemo(() => ({
    active: runs.filter((run) => !new Set<WorkflowStatus>(["completed", "cancelled", "failed"]).has(run.status)).length,
    completed: runs.filter((run) => run.status === "completed").length,
    attention: runs.filter((run) => new Set<WorkflowStatus>(["waiting_input", "waiting_confirmation", "verification_pending", "failed"]).has(run.status)).length,
  }), [runs]);

  const addRun = (run: BusinessWorkflowRun) => setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
  const startProduct = async () => {
    const publishPrice = Number(product.price);
    if (!product.sourceUrl.trim() || !Number.isFinite(publishPrice) || publishPrice <= 0) { setError("请填写完整的 1688 链接和大于 0 的发布售价。"); return; }
    const dimensionValues = [product.length, product.width, product.height];
    if (dimensionValues.some(Boolean) && !dimensionValues.every((value) => Number(value) > 0)) { setError("尺寸要么不填，要么完整填写长、宽、高。"); return; }
    setStarting(true); setError(undefined);
    try {
      const result = await api.startProductPublishWorkflow({ sourceUrl: product.sourceUrl.trim(), publishPrice, currency: "THB", ...(dimensionValues.every(Boolean) ? { packageDimensions: { length: Number(product.length), width: Number(product.width), height: Number(product.height) } } : {}) });
      addRun(result.run); setProduct({ sourceUrl: "", price: "", length: "", width: "", height: "" });
    } catch (startError) { setError(startError instanceof Error ? startError.message : "任务创建失败。"); }
    finally { setStarting(false); }
  };
  const startFlash = async () => {
    setStarting(true); setError(undefined);
    try {
      const result = await api.startFlashSaleWorkflow({ productId: flash.productId.trim(), activityTitle: flash.title.trim() || `FlashSale-${flash.productId.slice(-6)}`, startAt: new Date(flash.startAt).toISOString(), endAt: new Date(flash.endAt).toISOString(), priceAmount: flash.price.trim(), currency: flash.currency, skuQuantityLimit: Number(flash.quantity), quantityPerUser: Number(flash.perUser) });
      addRun(result.run);
    } catch (startError) { setError(startError instanceof Error ? startError.message : "秒杀任务创建失败。"); }
    finally { setStarting(false); }
  };
  const updateRun = (next: BusinessWorkflowRun) => setRuns((current) => current.map((run) => run.id === next.id ? next : run));

  const attentionStatuses = new Set<WorkflowStatus>(["waiting_input", "waiting_confirmation", "verification_pending", "failed"]);
  const filteredRuns = useMemo(() => runs.filter((run) => {
    const matchesQuery = `${run.title} ${workflowTypeLabel(run)} ${run.id}`.toLowerCase().includes(runQuery.trim().toLowerCase());
    if (!matchesQuery) return false;
    if (runFilter === "active") return ACTIVE_STATUSES.has(run.status);
    if (runFilter === "attention") return attentionStatuses.has(run.status);
    if (runFilter === "completed") return run.status === "completed";
    return true;
  }), [runs, runFilter, runQuery]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? filteredRuns[0];
  const allTemplates = [...WORKFLOW_TEMPLATES, ...savedTemplates];

  const openTemplateBuilder = (template: WorkflowTemplate) => {
    setBuilderName(template.name);
    setBuilderNodes(template.nodes.map((node) => ({ ...node })));
    setSelectedNodeId(template.nodes[0]?.id ?? "");
    setSaveNotice(undefined);
    onTabChange("builder");
  };

  const launchTemplate = (template: WorkflowTemplate) => {
    if (template.launch === "chat") {
      onOpenChat(template.prompt ?? `按“${template.name}”工作流执行`);
      return;
    }
    setMode(template.launch);
    setShowLauncher(true);
    onTabChange("monitor");
  };

  const addBuilderNode = (definition: Omit<BlueprintNode, "id">) => {
    const node = { ...definition, id: `node-${Date.now()}-${builderNodes.length}` };
    setBuilderNodes((current) => [...current, node]);
    setSelectedNodeId(node.id);
    setSaveNotice(undefined);
  };

  const removeBuilderNode = (id: string) => {
    setBuilderNodes((current) => current.filter((node) => node.id !== id));
    if (selectedNodeId === id) setSelectedNodeId("");
    setSaveNotice(undefined);
  };

  const moveBuilderNode = (targetIndex: number) => {
    if (draggedNodeIndex === undefined || draggedNodeIndex === targetIndex) return;
    setBuilderNodes((current) => {
      const next = [...current];
      const [moved] = next.splice(draggedNodeIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDraggedNodeIndex(undefined);
    setSaveNotice(undefined);
  };

  const saveBuilder = () => {
    const name = builderName.trim() || "未命名工作流";
    if (!builderNodes.length) { setSaveNotice("请先添加至少一个节点。"); return; }
    const template: WorkflowTemplate = {
      id: `custom-${Date.now()}`,
      name,
      description: `自定义工作流，共 ${builderNodes.length} 个节点。`,
      category: "自定义",
      launch: "chat",
      prompt: `请按这个工作流执行：${builderNodes.map((node) => node.label).join("→")}。涉及写入时先让我审批。`,
      nodes: builderNodes.map((node) => ({ ...node })),
    };
    const next = [template, ...savedTemplates.filter((item) => item.name !== name)];
    setSavedTemplates(next);
    window.localStorage.setItem(SAVED_WORKFLOWS_KEY, JSON.stringify(next));
    setSaveNotice("已保存到工作流模板。");
  };

  const deleteSavedTemplate = (id: string) => {
    const next = savedTemplates.filter((template) => template.id !== id);
    setSavedTemplates(next);
    window.localStorage.setItem(SAVED_WORKFLOWS_KEY, JSON.stringify(next));
  };

  const selectedNode = builderNodes.find((node) => node.id === selectedNodeId);

  return (
    <div className="workflow-center">
      <div className="workflow-primary-tabs" role="tablist" aria-label="工作流视图">
        <button className={activeTab === "monitor" ? "active" : ""} onClick={() => onTabChange("monitor")}><Workflow size={16} />运行监控</button>
        <button className={activeTab === "templates" ? "active" : ""} onClick={() => onTabChange("templates")}><LayoutTemplate size={16} />工作流模板</button>
        <button className={activeTab === "builder" ? "active" : ""} onClick={() => onTabChange("builder")}><GitBranch size={16} />可视化编排</button>
      </div>

      {activeTab === "monitor" && <>
      <div className="workflow-monitor-toolbar">
        <div className="workflow-live-status"><span />实时监控{lastUpdatedAt && <small>{lastUpdatedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</small>}</div>
        <button className="secondary-button" onClick={() => setShowLauncher((value) => !value)}>{showLauncher ? <Ban size={15} /> : <Plus size={15} />}{showLauncher ? "收起新建" : "新建运行"}</button>
      </div>
      {showLauncher && <section className="workflow-launcher">
        <div className="workflow-mode-tabs"><button className={mode === "product" ? "active" : ""} onClick={() => setMode("product")}><PackageCheck size={15} />供应商上架</button><button className={mode === "flash" ? "active" : ""} onClick={() => setMode("flash")}><Zap size={15} />秒杀活动</button></div>
        {mode === "product" ? <><div><span className="eyebrow">供应商到店铺</span><h2>1688 商品发布到 TikTok</h2><p>按完整链路完成采集、认领、编辑保存、发布和结果回查。</p></div><div className="workflow-launch-form workflow-launch-form--grid"><input className="wide" aria-label="1688 商品链接" placeholder="1688 商品链接" value={product.sourceUrl} onChange={(event) => setProduct((value) => ({ ...value, sourceUrl: event.target.value }))} /><input aria-label="发布售价" inputMode="decimal" placeholder="发布售价（THB）" value={product.price} onChange={(event) => setProduct((value) => ({ ...value, price: event.target.value }))} /><input inputMode="decimal" placeholder="长 cm（可选）" value={product.length} onChange={(event) => setProduct((value) => ({ ...value, length: event.target.value }))} /><input inputMode="decimal" placeholder="宽 cm（可选）" value={product.width} onChange={(event) => setProduct((value) => ({ ...value, width: event.target.value }))} /><input inputMode="decimal" placeholder="高 cm（可选）" value={product.height} onChange={(event) => setProduct((value) => ({ ...value, height: event.target.value }))} /><button className="primary-button" disabled={starting} onClick={() => void startProduct()}>{starting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}开始上架流程</button></div></>
        : <><div><span className="eyebrow">促销活动</span><h2>创建 TikTok SKU 秒杀</h2><p>先核对商品、SKU 和库存，确认后创建活动并回查生效结果。</p></div><div className="workflow-launch-form workflow-launch-form--grid"><input aria-label="TikTok 商品 ID" placeholder="TikTok 商品 ID" value={flash.productId} onChange={(event) => setFlash((value) => ({ ...value, productId: event.target.value }))} /><input placeholder="活动名称（可选）" value={flash.title} onChange={(event) => setFlash((value) => ({ ...value, title: event.target.value }))} /><label><span>开始时间</span><input type="datetime-local" value={flash.startAt} onChange={(event) => setFlash((value) => ({ ...value, startAt: event.target.value }))} /></label><label><span>结束时间</span><input type="datetime-local" value={flash.endAt} onChange={(event) => setFlash((value) => ({ ...value, endAt: event.target.value }))} /></label><input inputMode="decimal" placeholder="秒杀价" value={flash.price} onChange={(event) => setFlash((value) => ({ ...value, price: event.target.value }))} /><select value={flash.currency} onChange={(event) => setFlash((value) => ({ ...value, currency: event.target.value }))}><option>THB</option><option>USD</option><option>VND</option><option>MYR</option><option>PHP</option><option>SGD</option><option>IDR</option></select><input inputMode="numeric" placeholder="每 SKU 活动库存" value={flash.quantity} onChange={(event) => setFlash((value) => ({ ...value, quantity: event.target.value }))} /><input inputMode="numeric" placeholder="每人限购" value={flash.perUser} onChange={(event) => setFlash((value) => ({ ...value, perUser: event.target.value }))} /><button className="primary-button" disabled={starting} onClick={() => void startFlash()}>{starting ? <LoaderCircle className="spin" size={16} /> : <Zap size={16} />}生成秒杀方案</button></div></>}
        {error && <div className="workflow-error"><AlertCircle size={15} /><span>{error}</span></div>}
      </section>}
      <div className="workflow-summary-band"><div><span>进行中</span><strong>{counts.active}</strong></div><div><span>等待处理</span><strong>{counts.attention}</strong></div><div><span>已完成</span><strong>{counts.completed}</strong></div></div>
      <div className="workflow-run-toolbar">
        <div className="workflow-filter-tabs">
          {([['all', '全部'], ['active', '进行中'], ['attention', '待处理'], ['completed', '已完成']] as const).map(([value, label]) => <button className={runFilter === value ? "active" : ""} key={value} onClick={() => setRunFilter(value)}>{label}</button>)}
        </div>
        <label className="workflow-run-search"><Search size={15} /><input value={runQuery} onChange={(event) => setRunQuery(event.target.value)} placeholder="搜索任务或编号" /></label>
      </div>
      {loading && <div className="workflow-empty"><LoaderCircle className="spin" size={20} /><span>正在读取任务…</span></div>}
      {!loading && runs.length === 0 && <div className="workflow-empty"><PackageCheck size={22} /><strong>还没有业务任务</strong><span>从上面的供应商上架或秒杀活动开始。</span></div>}
      {!loading && runs.length > 0 && <div className="workflow-monitor-layout">
        <div className="workflow-run-index">
          {filteredRuns.map((run) => <button className={selectedRun?.id === run.id ? "active" : ""} key={run.id} onClick={() => setSelectedRunId(run.id)}>
            <span className={`workflow-run-state workflow-run-state--${run.status}`} />
            <span><strong>{run.title}</strong><small>{workflowTypeLabel(run)} · {currentStepLabel(run)}</small></span>
            <time>{shortDate(run.updatedAt)}</time>
          </button>)}
          {!filteredRuns.length && <div className="workflow-index-empty">没有符合条件的任务</div>}
        </div>
        <div className="workflow-run-detail">
          {selectedRun && <WorkflowRunCard initialRun={selectedRun} key={selectedRun.id} onChange={updateRun} />}
        </div>
      </div>}
      </>}

      {activeTab === "templates" && <div className="workflow-template-grid">
        {allTemplates.map((template) => <article className="workflow-template" key={template.id}>
          <header><span><LayoutTemplate size={17} /></span><small>{template.category}</small>{template.id.startsWith("custom-") && <button title="删除模板" aria-label={`删除 ${template.name}`} onClick={() => deleteSavedTemplate(template.id)}><Trash2 size={14} /></button>}</header>
          <h2>{template.name}</h2>
          <p>{template.description}</p>
          <div className="workflow-template-route">{template.nodes.slice(0, 5).map((node, index) => <span key={node.id}>{node.label}{index < Math.min(template.nodes.length, 5) - 1 && <ArrowRight size={12} />}</span>)}{template.nodes.length > 5 && <small>+{template.nodes.length - 5}</small>}</div>
          <footer><button className="secondary-button" onClick={() => openTemplateBuilder(template)}><GitBranch size={15} />编排</button><button className="primary-button" onClick={() => launchTemplate(template)}><Play size={15} />使用模板</button></footer>
        </article>)}
      </div>}

      {activeTab === "builder" && <div className="workflow-builder">
        <aside className="workflow-node-palette">
          <div><strong>节点</strong><span>点击添加到流程</span></div>
          {NODE_CATALOG.map((node) => {
            const Icon = NODE_KIND_META[node.kind].icon;
            return <button key={`${node.kind}-${node.label}`} onClick={() => addBuilderNode(node)}><Icon size={16} /><span><strong>{node.label}</strong><small>{NODE_KIND_META[node.kind].label}</small></span><Plus size={14} /></button>;
          })}
        </aside>
        <section className="workflow-builder-main">
          <div className="workflow-builder-toolbar">
            <input value={builderName} onChange={(event) => { setBuilderName(event.target.value); setSaveNotice(undefined); }} aria-label="工作流名称" />
            <span>{builderNodes.length} 个节点</span>
            <button className="secondary-button" onClick={() => { setBuilderNodes([]); setSelectedNodeId(""); setSaveNotice(undefined); }}><Trash2 size={15} />清空</button>
            <button className="secondary-button" onClick={saveBuilder}><Save size={15} />保存模板</button>
            <button className="primary-button" disabled={!builderNodes.length} onClick={() => onOpenChat(`请按这个工作流执行：${builderNodes.map((node) => node.label).join("→")}。涉及写入时先让我审批。`)}><MessageSquareText size={15} />交给运营总监</button>
          </div>
          {saveNotice && <div className="workflow-save-notice"><CheckCircle2 size={15} />{saveNotice}</div>}
          <div className="workflow-canvas">
            {builderNodes.length === 0 && <div className="workflow-canvas-empty"><Workflow size={24} /><strong>还没有节点</strong><span>从左侧添加触发器、Agent 或工具。</span></div>}
            <div className="workflow-node-flow">
              {builderNodes.map((node, index) => {
                const meta = NODE_KIND_META[node.kind];
                const Icon = meta.icon;
                return <div
                  className={`workflow-builder-node workflow-builder-node--${node.kind} ${selectedNodeId === node.id ? "active" : ""}`}
                  draggable
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  onDragStart={() => setDraggedNodeIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => moveBuilderNode(index)}
                >
                  <GripVertical className="workflow-node-grip" size={15} />
                  <span className="workflow-node-icon"><Icon size={18} /></span>
                  <small>{meta.label}</small>
                  <strong>{node.label}</strong>
                  <p>{node.detail}</p>
                  <button title="删除节点" aria-label={`删除 ${node.label}`} onClick={(event) => { event.stopPropagation(); removeBuilderNode(node.id); }}><Trash2 size={13} /></button>
                </div>;
              })}
            </div>
          </div>
        </section>
        <aside className="workflow-node-inspector">
          <div><strong>节点设置</strong><span>选中节点后查看</span></div>
          {selectedNode ? <>
            <span className={`workflow-inspector-icon workflow-builder-node--${selectedNode.kind}`}>{(() => { const Icon = NODE_KIND_META[selectedNode.kind].icon; return <Icon size={18} />; })()}</span>
            <label><span>类型</span><input readOnly value={NODE_KIND_META[selectedNode.kind].label} /></label>
            <label><span>名称</span><input value={selectedNode.label} onChange={(event) => setBuilderNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, label: event.target.value } : node))} /></label>
            <label><span>说明</span><textarea value={selectedNode.detail} onChange={(event) => setBuilderNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, detail: event.target.value } : node))} /></label>
            <p>拖动中间节点可以调整执行顺序。</p>
          </> : <div className="workflow-inspector-empty">选择一个节点</div>}
        </aside>
      </div>}
    </div>
  );
}
