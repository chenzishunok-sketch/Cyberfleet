import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ExternalLink,
  Info,
  KeyRound,
  LoaderCircle,
  RefreshCcw,
  X,
} from "lucide-react";
import type { LlmProviderSummary, LlmProviderTestResult } from "../../shared/contracts";
import { api } from "../api";

export type LlmWizardStep = "preset" | "credentials" | "test";

interface LlmWizardProps {
  onClose: () => void;
  /** 编辑换绑时传入已有服务，直接进入凭证步骤并预填 */
  editing?: LlmProviderSummary;
  demoMode: boolean;
  /** 保存后通知 App 刷新大模型概览与健康状态 */
  onSaved: () => Promise<void> | void;
}

interface LlmPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  keyUrl: string;
}

const LLM_PRESETS: LlmPreset[] = [
  { id: "deepseek", name: "DeepSeek 深度求索", baseUrl: "https://api.deepseek.com/v1", models: "deepseek-chat、deepseek-reasoner", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "kimi", name: "Kimi 月之暗面", baseUrl: "https://api.moonshot.cn/v1", models: "moonshot-v1-8k、kimi 系列", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { id: "qwen", name: "通义千问 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: "qwen-plus、qwen-max、qwen-turbo", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  { id: "glm", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: "glm-4.5、glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", models: "gpt-4o-mini、gpt-4.1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", name: "OpenRouter 聚合", baseUrl: "https://openrouter.ai/api/v1", models: "openai/gpt-4o-mini 等聚合模型", keyUrl: "https://openrouter.ai/keys" },
  { id: "ollama", name: "Ollama 本地模型", baseUrl: "http://localhost:11434/v1", models: "本机已拉取的模型（如 llama3.1、qwen2.5）", keyUrl: "" },
  { id: "custom", name: "自定义服务", baseUrl: "", models: "任意 OpenAI-compatible 服务", keyUrl: "" },
];

export function LlmWizard({ onClose, editing, demoMode, onSaved }: LlmWizardProps) {
  const [step, setStep] = useState<LlmWizardStep>(editing ? "credentials" : "preset");
  const [presetId, setPresetId] = useState("custom");
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(editing?.model ?? "");
  const [fastModel, setFastModel] = useState(editing?.fastModel ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmProviderTestResult>();
  const [setAsCurrent, setSetAsCurrent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const choosePreset = (preset: LlmPreset) => {
    setPresetId(preset.id);
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (!name.trim()) setName(preset.id === "custom" ? "" : preset.name);
    setStep("credentials");
  };

  const fetchModels = async () => {
    if (loadingModels) return;
    setLoadingModels(true);
    setError(undefined);
    try {
      const result = await api.llmProviderModels({
        ...(editing ? { id: editing.id } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (result.models.length) setModels(result.models);
      else setError(result.error ?? "没有读取到模型列表，可手动填写模型名。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取模型列表失败，可手动填写模型名。");
    } finally {
      setLoadingModels(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setError(undefined);
    try {
      const result = await api.testLlmProvider({
        ...(editing ? { id: editing.id } : {}),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model: model.trim(),
      });
      setTestResult(result);
    } catch (caught) {
      setTestResult({ ok: false, latencyMs: 0, error: caught instanceof Error ? caught.message : "测试请求失败。" });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (step === "test" && !testResult && !testing) void runTest();
  // 进入测试步骤时自动发起一次连接测试
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const credentialsReady = Boolean(name.trim() && baseUrl.trim() && model.trim() && (apiKey.trim() || editing));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const input = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(fastModel.trim() ? { fastModel: fastModel.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const result = editing
        ? await api.updateLlmProvider(editing.id, input)
        : await api.addLlmProvider({ ...input, apiKey: apiKey.trim() });
      if (setAsCurrent) await api.activateLlmProvider(result.provider.id);
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存模型服务失败。");
    } finally {
      setSaving(false);
    }
  };

  const STEP_ORDER: Array<{ id: LlmWizardStep; label: string }> = [
    ...(editing ? [] : [{ id: "preset" as const, label: "选择服务商" }]),
    { id: "credentials", label: "填写凭证" },
    { id: "test", label: "测试并保存" },
  ];
  const stepIndex = STEP_ORDER.findIndex((item) => item.id === step);

  return (
    <div className="skill-manager-backdrop" onClick={onClose}>
      <div className="skill-manager connection-wizard" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="llm-wizard-title">
        <div className="skill-manager-header">
          <div>
            <h2 id="llm-wizard-title">{editing ? `编辑模型服务 · ${editing.name}` : "绑定大模型服务"}</h2>
            <p>支持 OpenAI-compatible 接口；保存后立即对对话、路由和内容生成生效，无需重启。</p>
          </div>
          <button className="icon-button" aria-label="关闭向导" title="关闭向导" onClick={onClose}><X size={20} /></button>
        </div>

        {demoMode && (
          <div className="wizard-banner wizard-banner--info">
            <Info size={15} />
            <span>当前处于演示模式。绑定的模型服务会在退出演示模式后用于真实对话。</span>
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
          {step === "preset" && (
            <div className="wizard-section">
              <h3><Bot size={17} />选择模型服务商</h3>
              <div className="llm-preset-grid">
                {LLM_PRESETS.map((preset) => (
                  <button key={preset.id} className={`llm-preset-card ${presetId === preset.id ? "llm-preset-card--active" : ""}`} onClick={() => choosePreset(preset)}>
                    <strong>{preset.name}</strong>
                    {preset.baseUrl && <code>{new URL(preset.baseUrl).host}</code>}
                    <small>{preset.models}</small>
                  </button>
                ))}
              </div>
              <p className="wizard-note">都可以随时再添加多个服务并在设置页一键切换；API Key 只保存在本机服务端（.data 目录，权限 600）。</p>
            </div>
          )}

          {step === "credentials" && (
            <div className="wizard-section">
              <h3><KeyRound size={17} />服务凭证</h3>
              <div className="skill-config-fields">
                <div className="skill-config-field">
                  <label htmlFor="llm-name">服务名称<span className="skill-config-required">*</span></label>
                  <input id="llm-name" type="text" value={name} placeholder="例如：DeepSeek 主力" onChange={(event) => setName(event.target.value)} autoComplete="off" />
                </div>
                <div className="skill-config-field">
                  <label htmlFor="llm-base-url">Base URL<span className="skill-config-required">*</span></label>
                  <input id="llm-base-url" type="url" value={baseUrl} placeholder="https://api.deepseek.com/v1" onChange={(event) => setBaseUrl(event.target.value)} autoComplete="off" />
                </div>
                <div className="skill-config-field">
                  <label htmlFor="llm-api-key">API Key{!editing && <span className="skill-config-required">*</span>}</label>
                  <input
                    id="llm-api-key"
                    type="password"
                    value={apiKey}
                    placeholder={editing ? "已配置，留空保持不变" : "sk-..."}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div className="skill-config-field">
                  <label htmlFor="llm-model">模型名称<span className="skill-config-required">*</span></label>
                  <div className="llm-model-row">
                    <input id="llm-model" type="text" list="llm-model-options" value={model} placeholder="deepseek-chat" onChange={(event) => setModel(event.target.value)} autoComplete="off" />
                    <datalist id="llm-model-options">{models.map((item) => <option key={item} value={item} />)}</datalist>
                    <button className="secondary-button" disabled={loadingModels || (!baseUrl.trim() || (!apiKey.trim() && !editing))} onClick={() => void fetchModels()}>
                      {loadingModels ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}
                      {loadingModels ? "读取中" : "获取模型列表"}
                    </button>
                  </div>
                </div>
                <div className="skill-config-field">
                  <label htmlFor="llm-fast-model">快速模型（可选）</label>
                  <input id="llm-fast-model" type="text" list="llm-model-options" value={fastModel} placeholder="留空使用主模型；可填更便宜的轻量模型" onChange={(event) => setFastModel(event.target.value)} autoComplete="off" />
                  <small className="llm-field-hint">用于意图路由、摘要等轻量任务，降低调用成本。</small>
                </div>
              </div>
              {presetId !== "custom" && !editing && LLM_PRESETS.find((preset) => preset.id === presetId)?.keyUrl && (
                <p className="wizard-note">
                  还没有 API Key？
                  <a href={LLM_PRESETS.find((preset) => preset.id === presetId)!.keyUrl} target="_blank" rel="noreferrer">去获取 {LLM_PRESETS.find((preset) => preset.id === presetId)!.name} API Key<ExternalLink size={12} /></a>
                </p>
              )}
              <div className="wizard-actions">
                {!editing && <button className="skill-config-cancel" onClick={() => setStep("preset")}>上一步</button>}
                <button className="skill-config-save" disabled={!credentialsReady} onClick={() => { setTestResult(undefined); setStep("test"); }}>
                  下一步：测试连接<ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {step === "test" && (
            <div className="wizard-section">
              <h3><CheckCircle2 size={17} />测试并保存</h3>
              <div className={`llm-test-result ${testResult ? (testResult.ok ? "llm-test-result--ok" : "llm-test-result--fail") : ""}`}>
                {testing && <><LoaderCircle size={16} className="spin" /><span>正在连接 {baseUrl.trim() || "模型服务"} 并发送测试消息…</span></>}
                {!testing && testResult?.ok && (
                  <>
                    <CheckCircle2 size={16} />
                    <span>连接成功 · {testResult.latencyMs} ms{testResult.reply ? ` · 模型回复：${testResult.reply}` : ""}</span>
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
              <p className="wizard-note">测试会向上游发送一条极短的验证消息（约 16 token）。Key 无效、余额不足、模型名写错时这里会直接显示上游返回的真实原因。</p>
              <label className="llm-current-toggle">
                <input type="checkbox" checked={setAsCurrent} onChange={(event) => setSetAsCurrent(event.target.checked)} />
                保存后设为当前使用的模型服务
              </label>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={() => setStep("credentials")}>返回修改</button>
                <button className="secondary-button" disabled={saving} onClick={() => void save()}>跳过测试直接保存</button>
                <button className="skill-config-save" disabled={saving || !testResult?.ok} onClick={() => void save()}>
                  {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                  <span>{saving ? "正在保存" : editing ? "保存修改" : "保存并启用"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
