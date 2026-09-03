import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SalesPoint } from "../../shared/contracts";

export default function SalesChart({ series, currency }: { series: SalesPoint[]; currency: string }) {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const currencyFormatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency: safeCurrency, maximumFractionDigits: 2 });
  const compactFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#e8eaed" strokeDasharray="3 3" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#7a7f87", fontSize: 12 }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: "#7a7f87", fontSize: 11 }} tickFormatter={(value) => compactFormatter.format(Number(value))} />
        <Tooltip formatter={(value) => [currencyFormatter.format(Number(value)), "GMV"]} contentStyle={{ borderRadius: 6, border: "1px solid #dfe2e6", boxShadow: "0 8px 24px rgba(20,24,31,.08)", fontSize: 12 }} />
        <Line type="monotone" dataKey="previous" stroke="#b8bcc2" strokeWidth={1.5} strokeDasharray="5 5" dot={false} />
        <Line type="monotone" dataKey="sales" stroke="#111318" strokeWidth={2.5} dot={{ r: 2.5, fill: "#22d3c5", stroke: "#111318", strokeWidth: 1.5 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
