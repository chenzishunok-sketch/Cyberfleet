import { lazy, Suspense, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  Factory,
  FileText,
  Lightbulb,
  PackageCheck,
  PackageSearch,
  Play,
  Printer,
  ShieldCheck,
  Sparkles,
  Table2,
  TrendingUp,
  Truck,
  X,
} from "lucide-react";
import type { ActionPlan, MessageArtifact, ProductRow, VisualSection } from "../../shared/contracts";
import { WorkflowArtifact } from "./WorkflowCenter";
import {
  BarChart,
  CalloutBox,
  ComparisonTable,
  DataHighlightCard,
  DonutChart,
  InsightCard,
  RadarChart,
  Sparkline,
} from "./VisualAnalysis";

const SalesChart = lazy(() => import("./SalesChart"));

interface ArtifactRendererProps {
  artifact: MessageArtifact;
  busyActionId?: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onPrompt: (prompt: string) => void;
}

const statusLabels: Record<ProductRow["status"], string> = {
  healthy: "充足",
  low: "偏低",
  risk: "紧急",
};

function extractPeriodDays(...values: string[]): number | undefined {
  for (const value of values) {
    const match = value.match(/(?:近|过去|最近)\s*(\d{1,2})\s*天/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportProducts(products: ProductRow[]) {
  const rows = [
    ["SKU", "商品", "GMV", "销量", "库存", "库存天数"],
    ...products.map((product) => [product.sku, product.title, product.revenue, product.units, product.stock, product.daysOfStock]),
  ];
  downloadFile("stock-risk-products.csv", `\ufeff${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")}`, "text/csv;charset=utf-8");
}

function csvCell(value: string): string {
  const protectedValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

function exportRecords(artifact: Extract<MessageArtifact, { kind: "records" }>) {
  const rows = [
    artifact.columns.map((column) => column.label),
    ...artifact.rows.map((row) => artifact.columns.map((column) => row[column.key] ?? "")),
  ];
  const baseName = artifact.headline.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-|-$/g, "") || "tiktok-shop-data";
  downloadFile(`${baseName}.csv`, `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`, "text/csv;charset=utf-8");
}

function ApprovalCard({ plan, busy, onApprove, onReject }: { plan: ActionPlan; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const isPending = plan.status === "pending";
  const isVerificationPending = plan.status === "verification_pending";
  const needsAcknowledgement = plan.risk === "high";

  return (
    <section className={`artifact approval-card approval-card--${plan.risk}`}>
      <div className="artifact-header">
        <div className="artifact-title-row">
          <span className="artifact-icon artifact-icon--warning"><AlertTriangle size={17} /></span>
          <div>
            <span className="eyebrow">即将执行</span>
            <h3>{plan.title}</h3>
          </div>
        </div>
        <span className={`risk-badge risk-badge--${plan.risk}`}>{plan.risk === "high" ? "高风险" : "需确认"}</span>
      </div>

      <p className="artifact-summary">{plan.summary}</p>
      <dl className="plan-meta">
        <div><dt>店铺</dt><dd>{plan.store}</dd></div>
        <div><dt>影响范围</dt><dd>{plan.impactCount ?? plan.diffs.length} 个 SKU</dd></div>
        <div><dt>计划编号</dt><dd className="mono">{plan.planHash}</dd></div>
      </dl>

      <div className="diff-table" role="table" aria-label="变更预览">
        <div className="diff-row diff-row--header" role="row">
          <span>目标</span><span>字段</span><span>当前值</span><span>新值</span>
        </div>
        {plan.diffs.map((diff) => (
          <div className="diff-row" role="row" key={`${diff.target}-${diff.field}`}>
            <strong>{diff.target}</strong><span>{diff.field}</span><span className="old-value">{diff.before}</span><span className="new-value"><ArrowRight size={13} />{diff.after}</span>
          </div>
        ))}
      </div>

      {isPending && needsAcknowledgement && (
        <label className="acknowledgement">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>我已核对店铺范围与所有变更值</span>
        </label>
      )}

      <div className="artifact-actions">
        {isPending || isVerificationPending ? (
          <>
            <button className="primary-button" disabled={busy || (isPending && needsAcknowledgement && !acknowledged)} onClick={onApprove}>
              {busy ? <span className="button-spinner" /> : <Check size={16} />}
              {busy ? (isVerificationPending ? "正在核验" : "正在执行") : (isVerificationPending ? "重新核验结果" : "审核并执行")}
            </button>
            {isPending && <button className="secondary-button" disabled={busy} onClick={onReject}><X size={16} />取消计划</button>}
            <span className="expiry"><Clock3 size={13} />{isVerificationPending ? "不会重复提交，只回查结果" : "15 分钟内有效"}</span>
          </>
        ) : (
          <span className={`plan-status plan-status--${plan.status}`}>
            {plan.status === "approved" ? <CheckCircle2 size={16} /> : <X size={16} />}
            {plan.status === "approved" ? "已执行" : plan.status === "expired" ? "已过期" : plan.status === "executing" ? "执行中" : "已取消"}
          </span>
        )}
      </div>
    </section>
  );
}

export function ArtifactRenderer({ artifact, busyActionId, onApprove, onReject, onPrompt }: ArtifactRendererProps) {
  if (artifact.kind === "analysis") {
    const periodDays = artifact.series.length || extractPeriodDays(artifact.headline, artifact.source);
    const currentPeriodLabel = periodDays ? `近 ${periodDays} 天` : "本周期";
    const previousPeriodLabel = periodDays ? `前 ${periodDays} 天` : "上一周期";
    return (
      <section className="artifact analysis-artifact">
        <div className="artifact-header">
          <div className="artifact-title-row">
            <span className="artifact-icon"><Sparkles size={17} /></span>
            <h3>{artifact.headline}</h3>
          </div>
        </div>
        <div className="metric-grid">
          {artifact.metrics.map((metric) => (
            <div className="metric-item" key={metric.label}>
              <span className="metric-label">{metric.label}</span>
              <strong>{metric.value}</strong>
              <span className={`metric-delta metric-delta--${metric.trend}`}>
                {metric.trend === "up" ? <ArrowUpRight size={14} /> : metric.trend === "down" ? <ArrowDownRight size={14} /> : null}
                {metric.delta} <small>{metric.helper}</small>
              </span>
            </div>
          ))}
        </div>
        {artifact.series.length > 0 && (
          <>
            <div className="chart-header"><strong>支付 GMV 趋势</strong><div className="chart-legend"><span className="legend-current" />{currentPeriodLabel} <span className="legend-previous" />{previousPeriodLabel}</div></div>
            <div className="sales-chart" aria-label={`${currentPeriodLabel}销售趋势图`}>
              <Suspense fallback={<div className="chart-loading"><span className="button-spinner chart-spinner" />正在绘制趋势</div>}>
                <SalesChart series={artifact.series} currency={artifact.currency} />
              </Suspense>
            </div>
          </>
        )}
        <div className="insight-list">
          {artifact.insights.map((insight) => (
            <div className={`insight-row insight-row--${insight.tone}`} key={insight.label}>
              <Lightbulb size={16} /><div><strong>{insight.label}</strong><p>{insight.text}</p></div>
            </div>
          ))}
        </div>
        <p className="source-note">{artifact.source}</p>
      </section>
    );
  }

  if (artifact.kind === "products") {
    const periodDays = extractPeriodDays(artifact.summary, artifact.headline, artifact.source);
    const gmvLabel = periodDays ? `近 ${periodDays} 天 GMV` : "本周期 GMV";
    return (
      <section className="artifact products-artifact">
        <div className="artifact-header">
          <div className="artifact-title-row"><span className="artifact-icon artifact-icon--warning"><AlertTriangle size={17} /></span><h3>{artifact.headline}</h3></div>
          {artifact.products.length > 0 && <button className="icon-button" aria-label="导出 CSV" title="导出 CSV" onClick={() => exportProducts(artifact.products)}><Download size={17} /></button>}
        </div>
        <p className="artifact-summary">{artifact.summary}</p>
        {artifact.products.length > 0 && (
          <>
            <div className="product-table">
              <div className="product-row product-row--header"><span>商品</span><span>{gmvLabel}</span><span>销量</span><span>可售库存</span><span>状态</span></div>
              {artifact.products.map((product) => (
                <div className="product-row" key={product.id}>
                  <div className="product-cell">{product.image ? <img src={product.image} alt="" /> : <span className="product-image-placeholder"><PackageCheck size={18} /></span>}<div><strong>{product.title}</strong><span>{product.sku}</span></div></div>
                  <strong>{product.revenue}</strong>
                  <span>{product.units}</span>
                  <span>{product.stock} <small>· {product.daysOfStock === undefined ? "暂无销量" : `${product.daysOfStock} 天`}</small></span>
                  <span className={`stock-status stock-status--${product.status}`}>{statusLabels[product.status]}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="source-note">{artifact.source}</p>
      </section>
    );
  }

  if (artifact.kind === "sourcing_candidates") {
    return (
      <section className="sourcing-artifact">
        <div className="sourcing-heading">
          <div className="sourcing-query-image"><img src={artifact.queryImageUrl} alt="搜索原图" /></div>
          <div>
            <span className="eyebrow">货源选品 Agent</span>
            <h3>{artifact.headline}</h3>
            <p>{artifact.summary}</p>
          </div>
          <div className="sourcing-result-count"><strong>{artifact.totalCount}</strong><span>相似结果</span></div>
        </div>

        <div className="sourcing-assumptions">
          <span>{artifact.costNote}</span>
        </div>

        <div className="sourcing-candidate-grid">
          {artifact.candidates.map((candidate, index) => (
            <article className="sourcing-candidate" data-sourcing-item-id={candidate.itemId} key={candidate.itemId}>
              <div className="candidate-media">
                {candidate.imageUrl ? <img src={candidate.imageUrl} alt={candidate.title} /> : <span><PackageSearch size={26} /></span>}
                <div className="candidate-rank"><small>#{index + 1}</small><strong>{candidate.recommendationScore}</strong><span>推荐分</span></div>
              </div>
              <div className="candidate-content">
                <div className="candidate-title-row">
                  <h4>{candidate.title}</h4>
                  <a href={candidate.productUrl} target="_blank" rel="noreferrer" aria-label="打开1688商品" title="打开1688商品"><ExternalLink size={15} /></a>
                </div>
                <div className="candidate-supplier">
                  {candidate.supplierType === "生产工厂" ? <Factory size={14} /> : <PackageCheck size={14} />}
                  <strong>{candidate.supplierName}</strong>
                  <span>{candidate.supplierLocation}</span>
                  <span>{candidate.repurchaseRate === undefined ? "回头率 --" : `回头率 ${(candidate.repurchaseRate * 100).toFixed(0)}%`}{candidate.shopYears ? ` · ${candidate.shopYears} 年店` : ""}</span>
                </div>
                <div className="candidate-facts">
                  <div><span>采购价</span><strong>¥{candidate.purchasePriceCny.toFixed(2)}</strong><small>{candidate.minimumOrderQuantity} 件起</small></div>
                  <div><span>到岸成本</span><strong>¥{candidate.landedCostCny.toFixed(2)}</strong><small>{candidate.domesticShippingCny > 0 ? `含国内运费 ¥${candidate.domesticShippingCny.toFixed(2)}` : "未含国内运费"}</small></div>
                  <div><span>参考销量</span><strong>{candidate.salesCount.toLocaleString("zh-CN")}</strong><small>{candidate.ordersCount.toLocaleString("zh-CN")} 笔订单</small></div>
                  <div><span>重量</span><strong>{candidate.weightKg.toFixed(3)} kg</strong><small>{candidate.weightEstimated ? "暂估" : "货源数据"}</small></div>
                </div>
                {(candidate.tags.length > 0 || candidate.warnings.length > 0) && (
                  <div className="candidate-notes">
                    {candidate.tags.map((tag) => <span className="candidate-tag" key={tag}>{tag}</span>)}
                    {candidate.warnings.map((warning) => <span className="candidate-warning" key={warning}>{warning}</span>)}
                  </div>
                )}
                <div className="candidate-actions">
                  <button className="primary-button" onClick={() => onPrompt(`分析1688商品ID ${candidate.itemId} 的SKU、重量、供应商和风险，先不采集`)}><TrendingUp size={15} />选择并查看详情</button>
                  <button className="secondary-button" onClick={() => onPrompt(`把 ${candidate.productUrl} 采集并进入TikTok上架流程，先不发布`)}><Truck size={15} />进入上架</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (artifact.kind === "records") {
    return (
      <section className="artifact records-artifact">
        <div className="artifact-header">
          <div className="artifact-title-row"><span className="artifact-icon"><Table2 size={17} /></span><h3>{artifact.headline}</h3></div>
          {artifact.rows.length > 0 && (
            <button className="icon-button" aria-label="导出 CSV" title="导出 CSV" onClick={() => exportRecords(artifact)}><Download size={17} /></button>
          )}
        </div>
        <p className="artifact-summary">{artifact.summary}</p>
        {artifact.rows.length > 0 ? (
          <div className="records-table-wrap">
            <table className="records-table">
              <thead><tr>{artifact.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
              <tbody>
                {artifact.rows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${artifact.columns.map((column) => row[column.key] ?? "").join("-")}`}>
                    {artifact.columns.map((column) => <td key={column.key}>{row[column.key] || "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="records-empty"><Table2 size={20} /><span>{artifact.emptyLabel ?? "当前查询没有返回记录"}</span></div>
        )}
        <p className="source-note">{artifact.source}</p>
      </section>
    );
  }

  if (artifact.kind === "approval") {
    return <ApprovalCard plan={artifact.plan} busy={busyActionId === artifact.plan.id} onApprove={() => onApprove(artifact.plan.id)} onReject={() => onReject(artifact.plan.id)} />;
  }

  if (artifact.kind === "receipt") {
    return (
      <section className="artifact receipt-artifact">
        <div className="receipt-heading"><span className="success-icon"><Check size={18} /></span><div><span className="eyebrow">执行回执</span><h3>{artifact.title}</h3></div></div>
        <p>{artifact.summary}</p>
        <div className="receipt-meta"><span>{artifact.requestLabel ?? "API 请求编号"}</span><strong className="mono">{artifact.requestId}</strong><span>完成时间</span><strong>{new Date(artifact.completedAt).toLocaleString("zh-CN", { hour12: false })}</strong></div>
        <div className="diff-table receipt-diffs">
          {artifact.diffs.map((diff) => <div className="diff-row" key={`${diff.target}-${diff.field}`}><strong>{diff.target}</strong><span>{diff.field}</span><span className="old-value">{diff.before}</span><span className="new-value"><ArrowRight size={13} />{diff.after}</span></div>)}
        </div>
        <div className="verified-line"><ShieldCheck size={15} />{artifact.verificationLabel ?? "已回读店铺数据并验证"}</div>
      </section>
    );
  }

  if (artifact.kind === "report") {
    const markdown = `# ${artifact.title}\n\n${artifact.period}\n\n## 摘要\n${artifact.executiveSummary}\n\n${artifact.sections.map((section) => `## ${section.title}\n${section.stat ?? ""}\n\n${section.body}`).join("\n\n")}\n\n${artifact.source}`;
    return (
      <section className="artifact report-artifact">
        <div className="report-cover"><div><span className="eyebrow">经营报告</span><h3>{artifact.title}</h3><p>{artifact.period}</p></div><FileText size={34} /></div>
        <div className="report-summary"><strong>执行摘要</strong><p>{artifact.executiveSummary}</p></div>
        <div className="report-sections">
          {artifact.sections.map((section) => <div className="report-section" key={section.title}><div><strong>{section.title}</strong>{section.stat && <span>{section.stat}</span>}</div><p>{section.body}</p></div>)}
        </div>
        <div className="artifact-actions">
          <button className="primary-button" onClick={() => window.print()}><Printer size={16} />导出 PDF</button>
          <button className="secondary-button" onClick={() => downloadFile(`${artifact.title.replace(/[^\p{L}\p{N}-]+/gu, "-")}.md`, markdown, "text/markdown;charset=utf-8")}><Download size={16} />下载 Markdown</button>
        </div>
        <p className="source-note">{artifact.source}</p>
      </section>
    );
  }

  if (artifact.kind === "automation") {
    return (
      <section className="artifact automation-artifact">
        <div className="artifact-header"><div className="artifact-title-row"><span className="artifact-icon"><Clock3 size={17} /></span><div><span className="eyebrow">自动任务草稿</span><h3>{artifact.automation.name}</h3></div></div><span className="draft-badge">未启用</span></div>
        <dl className="plan-meta"><div><dt>运行时间</dt><dd>{artifact.automation.schedule}</dd></div><div><dt>店铺范围</dt><dd>{artifact.automation.scope}</dd></div><div><dt>写操作</dt><dd>无</dd></div></dl>
        <div className="condition-list">{artifact.conditions.map((condition) => <div key={condition}><CheckCircle2 size={15} /><span>{condition}</span></div>)}</div>
        {/* 这个按钮以前打的是一个恒 404 的接口。草稿要真正落地必须经调度引擎，
            所以改成把草稿交回对话，让负责调度的 Agent 来建任务。 */}
        <div className="artifact-actions"><button className="primary-button" onClick={() => onPrompt(`启用这个自动任务：${artifact.automation.name}（${artifact.automation.schedule}）`)}><Play size={16} />启用任务</button><button className="secondary-button" onClick={() => onPrompt("试运行这个自动任务")}>试运行</button></div>
      </section>
    );
  }

  if (artifact.kind === "workflow") {
    return <WorkflowArtifact initialRun={artifact.run} />;
  }

  if (artifact.kind === "visual_analysis") {
    return (
      <section className="artifact visual-analysis-artifact">
        <div className="visual-analysis-header">
          <div className="artifact-title-row">
            <span className="artifact-icon"><Sparkles size={17} /></span>
            <h3>{artifact.headline}</h3>
          </div>
        </div>
        <p className="visual-analysis-summary">{artifact.summary}</p>
        <div className="visual-analysis-sections">
          {artifact.sections.map((section, index) => (
            <VisualSectionRenderer key={index} section={section} />
          ))}
        </div>
        {artifact.source && <p className="source-note">{artifact.source}</p>}
      </section>
    );
  }

  return (
    <div className="suggestion-grid">
      {artifact.prompts.map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}><span>{prompt}</span><ArrowRight size={15} /></button>)}
    </div>
  );
}

function VisualSectionRenderer({ section }: { section: VisualSection }) {
  switch (section.type) {
    case "callout":
      return (
        <CalloutBox tone={section.tone} title={section.title}>
          {section.body}
        </CalloutBox>
      );
    case "data_highlights":
      return (
        <div className="vac-data-grid">
          {section.items.map((item, i) => (
            <DataHighlightCard key={i} {...item} />
          ))}
        </div>
      );
    case "bar_chart":
      return (
        <div className="vac-section">
          {section.title && <h4 className="vac-section-title">{section.title}</h4>}
          <BarChart items={section.items} unit={section.unit} />
        </div>
      );
    case "donut_chart":
      return (
        <div className="vac-section vac-donut-section">
          {section.title && <h4 className="vac-section-title">{section.title}</h4>}
          <DonutChart
            segments={section.segments}
            centerLabel={section.centerLabel}
            centerValue={section.centerValue}
          />
        </div>
      );
    case "radar_chart":
      return (
        <div className="vac-section vac-radar-section">
          {section.title && <h4 className="vac-section-title">{section.title}</h4>}
          <RadarChart items={section.items} />
        </div>
      );
    case "sparkline_row":
      return (
        <div className="vac-section">
          {section.title && <h4 className="vac-section-title">{section.title}</h4>}
          <div className="vac-sparkline-row">
            {section.items.map((item, i) => (
              <div className="vac-sparkline-item" key={i}>
                <span className="vac-sparkline-label">{item.label}</span>
                <Sparkline data={item.data} />
                <span className="vac-sparkline-value">{item.value}</span>
                {item.delta && <span className="vac-sparkline-delta">{item.delta}</span>}
              </div>
            ))}
          </div>
        </div>
      );
    case "comparison_table":
      return <ComparisonTable title={section.title} columns={section.columns} items={section.items} />;
    case "insights":
      return (
        <div className="vac-insight-list">
          {section.items.map((item, i) => (
            <InsightCard key={i} tone={item.tone} label={item.label} text={item.text} />
          ))}
        </div>
      );
    default:
      return null;
  }
}
