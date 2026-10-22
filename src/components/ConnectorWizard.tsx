import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  Info,
  LoaderCircle,
  Plug,
  X,
} from "lucide-react";
import type { SkillConnectionTestResult, SkillDefinition, SkillStatus } from "../../shared/contracts";
import { api } from "../api";

export type ConnectorWizardStep = "about" | "credentials" | "result";

interface ConnectorWizardProps {
  skill: SkillDefinition;
  status: SkillStatus;
  demoMode: boolean;
  onClose: () => void;
  /** 保存/测试后通知 App 刷新目录与健康状态 */
  onSaved: () => Promise<void> | void;
}

interface ConnectorHelp {
  business: string[];
  keyUrl?: string;
  keyUrlLabel?: string;
  testNote: string;
}

/** 各连接器的业务参与说明与获取密钥指引（展示层元数据，配置字段来自后端目录） */
const CONNECTOR_HELP: Record<string, ConnectorHelp> = {
  miaoshou: {
    business: ["1688 货源采集 → AI 类目匹配 → 一键上架 TikTok 的流水线中枢", "库存、包裹、采购、退货等 ERP 场景查询", "定价台账的店铺解析"],
    keyUrl: "https://open.91miaoshou.com",
    keyUrlLabel: "采集上架服务开放平台",
    testNote: "测试会真实调用采集上架服务 API（读取定价模板列表，单请求）。",
  },
  "tmapi-1688": {
    business: ["以图搜 1688 同款货源", "1688 商品详情、SKU、采购价读取", "定价 1688 比价与 DAG 选品搜货"],
    keyUrl: "https://www.tmapi.top",
    keyUrlLabel: "1688 货源数据服务",
    testNote: "测试会执行一次真实商品搜索（消耗 1 次调用额度；Token 无效/套餐过期会直接显示原因）。",
  },
  chuhaijiang: {
    business: ["TikTok 日区爆品/达人/店铺/直播数据工具注入对话", "DAG 选品搜索执行器"],
    keyUrl: "https://www.chuhaijiang.com",
    keyUrlLabel: "日区选品数据服务",
    testNote: "测试通过 MCP listTools 验证凭证，零消耗。",
  },
  "web-search": {
    business: ["对话中的联网搜索（web_search 工具）", "平台政策、市场趋势、竞品资料检索"],
    keyUrl: "https://app.tavily.com/home",
    keyUrlLabel: "Tavily 控制台",
    testNote: "测试会执行一次真实搜索（消耗 1 次搜索额度）。",
  },
  feishu: {
    business: ["DAG 审批与结果通知推送", "定时经营日报", "飞书消息机器人（保存凭证后重启服务生效）"],
    keyUrl: "https://open.feishu.cn/app",
    keyUrlLabel: "飞书开放平台（创建企业自建应用）",
    testNote: "测试会请求 tenant_access_token 验证凭证，零消耗。消息接收人（FEISHU_NOTIFY_CHAT_ID）仍在 .env 配置。",
  },
  fastmoss: {
    business: ["FastMoss TikTok 数据分析工具注入对话（爆品/达人/店铺/视频）"],
    keyUrl: "https://www.fastmoss.com",
    keyUrlLabel: "FastMoss 数据平台",
    testNote: "测试通过 MCP listTools 验证凭证，零消耗。",
  },
};

export function connectorHelp(skillId: string): ConnectorHelp | undefined {
  return CONNECTOR_HELP[skillId];
}

export function ConnectorWizard({ skill, status, demoMode, onClose, onSaved }: ConnectorWizardProps) {
  const [step, setStep] = useState<ConnectorWizardStep>("about");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of skill.configFields) {
      initial[field.key] = field.type === "password" ? "" : status.config[field.key] ?? "";
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SkillConnectionTestResult>();
  const [error, setError] = useState<string>();

  const help = CONNECTOR_HELP[skill.id];
  const requiredReady = skill.configFields
    .filter((field) => field.required)
    .every((field) => Boolean(values[field.key]?.trim()) || Boolean(status.config[field.key]));

  const saveAndTest = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const config: Record<string, string> = {};
      for (const field of skill.configFields) {
        const value = values[field.key]?.trim() ?? "";
        // 密码字段留空或带回显掩码时保持已保存值
        if (value && !(field.type === "password" && value.includes("*"))) config[field.key] = value;
      }
      if (Object.keys(config).length) await api.updateSkillConfig(skill.id, config);
      await onSaved();
      setSaving(false);
      setTesting(true);
      setStep("result");
      const result = await api.skillConnectionTest(skill.id);
      setTestResult(result);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存凭证失败。");
      setStep("credentials");
    } finally {
      setSaving(false);
      setTesting(false);
    }
  };

  const STEP_ORDER: Array<{ id: ConnectorWizardStep; label: string }> = [
    { id: "about", label: "服务说明" },
    { id: "credentials", label: "填写凭证" },
    { id: "result", label: "保存并测试" },
  ];
  const stepIndex = STEP_ORDER.findIndex((item) => item.id === step);

  return (
    <div className="skill-manager-backdrop" onClick={onClose}>
      <div className="skill-manager connection-wizard" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="connector-wizard-title">
        <div className="skill-manager-header">
          <div>
            <h2 id="connector-wizard-title">{status.configSource === "skill" ? `换绑 · ${skill.name}` : `绑定 · ${skill.name}`}</h2>
            <p>按步骤完成绑定：查看说明 → 填写密钥 → 保存并测试真实调用。</p>
          </div>
          <button className="icon-button" aria-label="关闭向导" title="关闭向导" onClick={onClose}><X size={20} /></button>
        </div>

        {demoMode && (
          <div className="wizard-banner wizard-banner--info">
            <Info size={15} />
            <span>当前处于演示模式。绑定的接口凭证会正常保存，退出演示模式后才会参与真实业务。</span>
          </div>
        )}

        <div className="wizard-steps" aria-label="绑定进度">
          {STEP_ORDER.map((item, index) => (
            <span key={item.id} className={`wizard-step ${item.id === step ? "wizard-step--active" : ""} ${index < stepIndex ? "wizard-step--done" : ""}`}>
              {index < stepIndex ? <Check size={12} /> : <i>{index + 1}</i>}
              {item.label}
            </span>
          ))}
        </div>

        {error && (
          <div className="skill-manager-error">
            <Info size={14} />
            <span>{error}</span>
            <button onClick={() => setError(undefined)} aria-label="关闭错误提示"><X size={14} /></button>
          </div>
        )}

        <div className="skill-manager-body wizard-body">
          {step === "about" && (
            <div className="wizard-section">
              <h3><Plug size={17} />{skill.name} 参与哪些业务</h3>
              <ol className="wizard-checklist">
                {help?.business.map((item) => <li key={item}>{item}</li>)}
              </ol>
              {help?.keyUrl && (
                <p className="wizard-note">
                  密钥获取：<a href={help.keyUrl} target="_blank" rel="noreferrer">{help.keyUrlLabel}<ExternalLink size={12} /></a>
                </p>
              )}
              <p className="wizard-note">密钥只保存在本机服务端（.data/skills.json，权限 600），保存后立即对业务链路生效，无需重启。</p>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={onClose}>取消</button>
                <button className="skill-config-save" onClick={() => setStep("credentials")}>下一步：填写凭证<ArrowRight size={14} /></button>
              </div>
            </div>
          )}

          {step === "credentials" && (
            <div className="wizard-section">
              <h3><Plug size={17} />{skill.name} 凭证</h3>
              <div className="skill-config-fields">
                {skill.configFields.map((field) => (
                  <div key={field.key} className="skill-config-field">
                    <label htmlFor={`connector-${field.key}`}>
                      {field.label}
                      {field.required && <span className="skill-config-required">*</span>}
                    </label>
                    <input
                      id={`connector-${field.key}`}
                      type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
                      value={values[field.key] ?? ""}
                      placeholder={field.type === "password" && status.config[field.key] ? "已配置，留空保持不变" : field.placeholder}
                      onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                      autoComplete={field.type === "password" ? "new-password" : "off"}
                    />
                  </div>
                ))}
              </div>
              {help && <p className="wizard-note">{help.testNote}</p>}
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={() => setStep("about")}>上一步</button>
                <button className="skill-config-save" disabled={!requiredReady || saving} onClick={() => void saveAndTest()}>
                  {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                  <span>{saving ? "正在保存" : "保存并测试"}</span>
                </button>
              </div>
            </div>
          )}

          {step === "result" && (
            <div className="wizard-section">
              <h3><CheckCircle2 size={17} />连接测试</h3>
              <div className={`llm-test-result ${testResult ? (testResult.ok ? "llm-test-result--ok" : "llm-test-result--fail") : ""}`}>
                {testing && <><LoaderCircle size={16} className="spin" /><span>正在调用 {skill.name} 的真实业务接口…</span></>}
                {!testing && testResult?.ok && (
                  <>
                    <CheckCircle2 size={16} />
                    <span>连接成功 · {testResult.latencyMs} ms{testResult.detail ? ` · ${testResult.detail}` : ""}</span>
                  </>
                )}
                {!testing && testResult && !testResult.ok && (
                  <>
                    <Info size={16} />
                    <span>连接失败：{testResult.error}</span>
                  </>
                )}
                {!testing && !testResult && <span>准备测试…</span>}
              </div>
              <p className="wizard-note">凭证已保存并立即生效于业务链路；测试失败时返回修改后可重新保存测试。</p>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={() => setStep("credentials")}>返回修改</button>
                <button className="skill-config-save" disabled={saving || testing || !testResult?.ok} onClick={onClose}>
                  <Check size={14} />
                  <span>完成</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
