import { memo, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Lightbulb,
  Minus,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

interface DataHighlightCardProps {
  label: string;
  value: string;
  unit?: string;
  trend?: "up" | "down" | "flat";
  delta?: string;
  helper?: string;
}

export const DataHighlightCard = memo(function DataHighlightCard({
  label,
  value,
  unit,
  trend,
  delta,
  helper,
}: DataHighlightCardProps) {
  return (
    <div className="vac-data-card">
      <span className="vac-data-label">{label}</span>
      <div className="vac-data-value-row">
        <span className="vac-data-value">{value}</span>
        {unit && <span className="vac-data-unit">{unit}</span>}
      </div>
      {trend && (
        <span className={`vac-data-delta vac-data-delta--${trend}`}>
          {trend === "up" && <ArrowUpRight size={13} />}
          {trend === "down" && <ArrowDownRight size={13} />}
          {trend === "flat" && <Minus size={13} />}
          {delta}
          {helper && <small>{helper}</small>}
        </span>
      )}
    </div>
  );
});

interface TrendLabelProps {
  direction: "up" | "down" | "flat";
  value: string;
  prefix?: string;
}

export const TrendLabel = memo(function TrendLabel({
  direction,
  value,
  prefix,
}: TrendLabelProps) {
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  return (
    <span className={`vac-trend vac-trend--${direction}`}>
      <Icon size={12} />
      {prefix && <span className="vac-trend-prefix">{prefix}</span>}
      <span className="vac-trend-value">{value}</span>
    </span>
  );
});

type CalloutTone = "conclusion" | "judgment" | "recommendation" | "warning" | "info";

interface CalloutBoxProps {
  tone: CalloutTone;
  title?: string;
  children: ReactNode;
}

const toneConfig: Record<
  CalloutTone,
  { icon: typeof Lightbulb; label: string; className: string }
> = {
  conclusion: { icon: CheckCircle2, label: "结论", className: "vac-callout--conclusion" },
  judgment: { icon: Lightbulb, label: "判断", className: "vac-callout--judgment" },
  recommendation: { icon: Target, label: "建议", className: "vac-callout--recommendation" },
  warning: { icon: AlertTriangle, label: "注意", className: "vac-callout--warning" },
  info: { icon: Sparkles, label: "说明", className: "vac-callout--info" },
};

export const CalloutBox = memo(function CalloutBox({
  tone,
  title,
  children,
}: CalloutBoxProps) {
  const config = toneConfig[tone];
  const Icon = config.icon;
  return (
    <div className={`vac-callout ${config.className}`}>
      <span className="vac-callout-icon">
        <Icon size={15} />
      </span>
      <div className="vac-callout-body">
        <span className="vac-callout-label">{title ?? config.label}</span>
        <div className="vac-callout-content">{children}</div>
      </div>
    </div>
  );
});

interface BarChartItem {
  label: string;
  value: number;
  valueLabel: string;
  delta?: string;
}

interface BarChartProps {
  items: BarChartItem[];
  maxValue?: number;
  unit?: string;
}

export const BarChart = memo(function BarChart({
  items,
  maxValue,
  unit,
}: BarChartProps) {
  const max = maxValue ?? Math.max(...items.map((i) => i.value));
  return (
    <div className="vac-bar-chart">
      {items.map((item) => {
        const pct = max > 0 ? (item.value / max) * 100 : 0;
        return (
          <div className="vac-bar-row" key={item.label}>
            <span className="vac-bar-label">{item.label}</span>
            <div className="vac-bar-track">
              <div
                className="vac-bar-fill"
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <span className="vac-bar-value">
              {item.valueLabel}
              {unit && <small>{unit}</small>}
            </span>
            {item.delta && (
              <span className="vac-bar-delta">{item.delta}</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

interface RadarChartItem {
  label: string;
  value: number;
  max: number;
}

interface RadarChartProps {
  items: RadarChartItem[];
  size?: number;
}

export const RadarChart = memo(function RadarChart({
  items,
  size = 220,
}: RadarChartProps) {
  const center = size / 2;
  const radius = size / 2 - 36;
  const n = items.length;
  if (n < 3) return null;
  const angleStep = (Math.PI * 2) / n;
  const dataPoints = items.map((item, i) => {
    const angle = -Math.PI / 2 + i * angleStep;
    const r = (item.value / item.max) * radius;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
      labelX: center + (radius + 18) * Math.cos(angle),
      labelY: center + (radius + 18) * Math.sin(angle),
      ...item,
    };
  });
  const axisPoints = items.map((_, i) => {
    const angle = -Math.PI / 2 + i * angleStep;
    return {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    };
  });
  const polygonPath = dataPoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ") + " Z";
  const gridLevels = [0.25, 0.5, 0.75, 1];
  return (
    <div className="vac-radar-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {gridLevels.map((level) => {
          const gridPoints = items.map((_, i) => {
            const angle = -Math.PI / 2 + i * angleStep;
            const r = radius * level;
            return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
          }).join(" ");
          return (
            <polygon
              key={level}
              points={gridPoints}
              fill="none"
              stroke="rgba(60,60,67,0.10)"
              strokeWidth={1}
            />
          );
        })}
        {axisPoints.map((p, i) => (
          <line
            key={i}
            x1={center}
            y1={center}
            x2={p.x}
            y2={p.y}
            stroke="rgba(60,60,67,0.08)"
            strokeWidth={1}
          />
        ))}
        <path
          d={polygonPath}
          fill="rgba(0,113,227,0.10)"
          stroke="#0071e3"
          strokeWidth={1.5}
        />
        {dataPoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill="#0071e3" />
        ))}
        {dataPoints.map((p, i) => (
          <text
            key={`label-${i}`}
            x={p.labelX}
            y={p.labelY}
            textAnchor={Math.cos(-Math.PI / 2 + i * angleStep) > 0.3 ? "start" : Math.cos(-Math.PI / 2 + i * angleStep) < -0.3 ? "end" : "middle"}
            dominantBaseline="middle"
            fill="#6e6e73"
            fontSize={11}
          >
            {p.label}
          </text>
        ))}
      </svg>
    </div>
  );
});

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
}

export const Sparkline = memo(function Sparkline({
  data,
  width = 120,
  height = 36,
  color = "#0071e3",
  fillColor = "rgba(0,113,227,0.08)",
}: SparklineProps) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => ({
    x: i * stepX,
    y: height - ((v - min) / range) * (height - 4) - 2,
  }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={areaPath} fill={fillColor} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2.5} fill={color} />
    </svg>
  );
});

interface DonutChartProps {
  segments: Array<{ label: string; value: number; color?: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}

const DEFAULT_COLORS = [
  "#0071e3",
  "#248a3d",
  "#a05a00",
  "#d70015",
  "#5e5ce6",
  "#30b0c7",
  "#bf5af2",
  "#ff9f0a",
];

export const DonutChart = memo(function DonutChart({
  segments,
  size = 140,
  thickness = 18,
  centerLabel,
  centerValue,
}: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let accumulated = 0;
  return (
    <div className="vac-donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(60,60,67,0.06)"
          strokeWidth={thickness}
        />
        {segments.map((segment, i) => {
          const color = segment.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
          const dashLength = (segment.value / total) * circumference;
          const gapLength = circumference - dashLength;
          const offset = -accumulated;
          accumulated += dashLength;
          return (
            <circle
              key={segment.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={thickness}
              strokeDasharray={`${dashLength} ${gapLength}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap="butt"
            />
          );
        })}
        {centerValue && (
          <text
            x={size / 2}
            y={size / 2 - 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#1d1d1f"
            fontSize={20}
            fontWeight={600}
          >
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text
            x={size / 2}
            y={size / 2 + 16}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#6e6e73"
            fontSize={11}
          >
            {centerLabel}
          </text>
        )}
      </svg>
      <div className="vac-donut-legend">
        {segments.map((segment, i) => (
          <div className="vac-donut-legend-item" key={segment.label}>
            <span
              className="vac-donut-swatch"
              style={{ background: segment.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length] }}
            />
            <span className="vac-donut-legend-label">{segment.label}</span>
            <span className="vac-donut-legend-value">
              {((segment.value / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

interface InsightCardProps {
  tone: "positive" | "warning" | "neutral";
  label: string;
  text: string;
}

export const InsightCard = memo(function InsightCard({
  tone,
  label,
  text,
}: InsightCardProps) {
  const Icon = tone === "positive" ? TrendingUp : tone === "warning" ? AlertTriangle : Lightbulb;
  return (
    <div className={`vac-insight vac-insight--${tone}`}>
      <span className="vac-insight-icon">
        <Icon size={14} />
      </span>
      <div className="vac-insight-body">
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
});

interface ComparisonTableItem {
  label: string;
  primaryValue: string;
  secondaryValue?: string;
  highlight?: boolean;
}

interface ComparisonTableProps {
  title?: string;
  items: ComparisonTableItem[];
  columns?: Array<{ key: "primary" | "secondary"; label: string }>;
}

export const ComparisonTable = memo(function ComparisonTable({
  title,
  items,
  columns,
}: ComparisonTableProps) {
  const defaultColumns = [
    { key: "primary" as const, label: "本期" },
    { key: "secondary" as const, label: "对比期" },
  ];
  const cols = columns ?? defaultColumns;
  return (
    <div className="vac-compare-table">
      {title && <h4 className="vac-compare-title">{title}</h4>}
      <div className="vac-compare-grid">
        <span className="vac-compare-cell vac-compare-cell--header">子类目</span>
        {cols.map((col) => (
          <span key={col.key} className="vac-compare-cell vac-compare-cell--header">
            {col.label}
          </span>
        ))}
        {items.map((item) => (
          <>
            <span
              className={`vac-compare-cell vac-compare-cell--label${item.highlight ? " vac-compare-cell--highlight" : ""}`}
              key={`label-${item.label}`}
            >
              {item.label}
            </span>
            <span className="vac-compare-cell vac-compare-cell--value" key={`primary-${item.label}`}>
              {item.primaryValue}
            </span>
            {cols.length > 1 && (
              <span className="vac-compare-cell vac-compare-cell--value" key={`secondary-${item.label}`}>
                {item.secondaryValue ?? "—"}
              </span>
            )}
          </>
        ))}
      </div>
    </div>
  );
});
