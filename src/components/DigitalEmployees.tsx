import { useMemo, useState } from "react";
import {
  ArrowRight,
  Search,
  Sparkles,
} from "lucide-react";
import {
  DIGITAL_EMPLOYEES,
  type AgentCategory,
  type AgentConnection,
  type AgentContext,
  type DigitalEmployee,
} from "../../shared/digital-employees";

type ConnectionState = Record<AgentConnection, boolean>;

interface DigitalEmployeesProps {
  connections: ConnectionState;
  onOpenAgent: (agentId: AgentContext) => void;
}

const categories: Array<"全部" | AgentCategory> = ["全部", "运营", "商品", "增长", "履约", "内容"];

function statusLabel(employee: DigitalEmployee, connections: ConnectionState): string {
  if (employee.status === "planned") return "规划中";
  if (employee.connection && !connections[employee.connection]) return "待连接";
  return employee.status === "foundation" ? "基础可用" : "可用";
}

export function DigitalEmployees({ connections, onOpenAgent }: DigitalEmployeesProps) {
  const [category, setCategory] = useState<(typeof categories)[number]>("全部");
  const [query, setQuery] = useState("");
  const employees = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return DIGITAL_EMPLOYEES.filter((employee) => {
      const matchesCategory = category === "全部" || employee.category === category;
      const matchesQuery = !needle || `${employee.name} ${employee.description} ${employee.capabilities.join(" ")}`.toLowerCase().includes(needle);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  return (
    <main className="page-content employees-page">
      <header className="employees-header">
        <div><h1>数字员工</h1><p>直接调用一个专业 Agent，或交给运营总监拆解并协调完整业务任务。</p></div>
        <div className="employees-overview"><Sparkles size={16} /><span>{DIGITAL_EMPLOYEES.filter((employee) => employee.status !== "planned").length} 位已纳入</span></div>
      </header>

      <div className="employees-toolbar">
        <div className="employee-categories" aria-label="筛选数字员工">
          {categories.map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <label className="employee-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索数字员工" aria-label="搜索数字员工" /></label>
      </div>

      <section className="employee-grid" aria-label="数字员工列表">
        {employees.map((employee) => {
          const planned = employee.status === "planned";
          const status = statusLabel(employee, connections);
          return (
            <button
              className={`employee-card ${employee.featured ? "employee-card--featured" : ""}`}
              key={employee.id}
              disabled={planned}
              onClick={() => onOpenAgent(employee.id)}
              aria-label={`${planned ? "尚未开放" : "进入"}${employee.name}`}
            >
              <div className="employee-card-heading"><span className={`employee-avatar employee-avatar--${employee.id}`} aria-hidden="true" /><span className={`employee-status employee-status--${planned ? "planned" : status === "待连接" ? "offline" : "ready"}`}>{status}</span></div>
              <div className="employee-card-copy"><h2>{employee.name}</h2><p>{employee.description}</p></div>
              {!planned && <div className="employee-card-footer"><span>进入工作区</span><ArrowRight size={15} /></div>}
            </button>
          );
        })}
      </section>
      {!employees.length && <div className="employees-empty"><Search size={22} /><strong>没有匹配的数字员工</strong><span>换一个关键词或分类试试。</span></div>}
    </main>
  );
}
