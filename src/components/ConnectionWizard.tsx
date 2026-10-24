import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  LoaderCircle,
  Store,
  X,
} from "lucide-react";
import type { SkillsCatalogResponse, TikTokConnectionStatus } from "../../shared/contracts";
import { api, API_BASE } from "../api";
import { regionLabel } from "../region-labels";

export type ConnectionWizardStep = "guide" | "credentials" | "authorize";

interface ConnectionWizardProps {
  onClose: () => void;
  tiktokConnection: TikTokConnectionStatus;
  /** 保存凭证 / 授权完成后通知 App 刷新连接状态 */
  onRefresh: () => Promise<void> | void;
  initialStep?: ConnectionWizardStep;
}

const STEP_ORDER: Array<{ id: ConnectionWizardStep; label: string }> = [
  { id: "guide", label: "准备凭证" },
  { id: "credentials", label: "应用密钥" },
  { id: "authorize", label: "前往授权" },
];

/** 需要复制到 TikTok Partner Center 的授权回调地址（子路径部署时自动带上 /cyberfleet 前缀） */
function callbackUrl(): string {
  return `${window.location.origin}${API_BASE}/api/tiktok/callback`;
}

export function ConnectionWizard({ onClose, tiktokConnection, onRefresh, initialStep = "guide" }: ConnectionWizardProps) {
  const [step, setStep] = useState<ConnectionWizardStep>(initialStep);
  const [catalog, setCatalog] = useState<SkillsCatalogResponse>();
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.skills().then((result) => {
      if (!cancelled) setCatalog(result);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const tiktokSkillStatus = catalog?.statuses.find((item) => item.id === "tiktok-shop");
  const credentialsConfigured = Boolean(tiktokSkillStatus?.config.appKey);
  const secretConfigured = Boolean(tiktokSkillStatus?.config.appSecret);

  // Service ID 不是敏感值，直接回显当前生效值，方便确认授权链接用的是哪个应用市场服务
  useEffect(() => {
    const current = tiktokSkillStatus?.config.serviceId?.trim();
    if (current) setServiceId((previous) => previous || current);
  }, [tiktokSkillStatus?.config.serviceId]);

  const copyCallbackUrl = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选择文本复制。");
    }
  };

  const saveCredentials = async () => {
    if (saving) return;
    if (!credentialsConfigured && !appKey.trim()) {
      setError("请填写 App Key，或回到上一步查看获取指引。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const config: Record<string, string> = {};
      if (appKey.trim()) config.appKey = appKey.trim();
      if (appSecret.trim()) config.appSecret = appSecret.trim();
      if (serviceId.trim()) config.serviceId = serviceId.trim();
      if (Object.keys(config).length) {
        await api.updateSkillConfig("tiktok-shop", config);
        setCatalog(await api.skills().catch(() => undefined));
        await onRefresh();
      }
      setStep("authorize");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存应用凭证失败。");
    } finally {
      setSaving(false);
    }
  };

  const visibleSteps = STEP_ORDER;
  const stepIndex = visibleSteps.findIndex((item) => item.id === step);

  return (
    <div className="skill-manager-backdrop" onClick={onClose}>
      <div className="skill-manager connection-wizard" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="connection-wizard-title">
        <div className="skill-manager-header">
          <div>
            <h2 id="connection-wizard-title">绑定 TikTok Shop 店铺</h2>
            <p>按步骤完成绑定：准备凭证 → 填写应用密钥 → 前往 TikTok 授权。</p>
          </div>
          <button className="icon-button" aria-label="关闭绑定向导" title="关闭绑定向导" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="wizard-steps" aria-label="绑定进度">
          {visibleSteps.map((item, index) => (
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
          {step === "guide" && (
            <div className="wizard-section">
              <h3><Store size={17} />绑定前需要准备什么</h3>
              <ol className="wizard-checklist">
                <li>一个 TikTok Shop 卖家账号（要用哪家公司绑定，就用它的卖家账号登录授权）。</li>
                <li>在 <strong>TikTok Partner Center</strong> 创建一个 App，拿到 <code>App Key</code> 和 <code>App Secret</code>。</li>
                <li>在该 App 的「Redirect URL」白名单中加入下面的回调地址。</li>
              </ol>
              <div className="wizard-callback-row">
                <code>{callbackUrl()}</code>
                <button className="secondary-button" onClick={() => void copyCallbackUrl()}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}
                </button>
              </div>
              <p className="wizard-note">同一份 App 凭证可以授权多个卖家账号；每绑定一个新账号，只需再走一次授权。App Secret 只保存在本机服务端（.data 目录，权限 600），不会发送到浏览器。</p>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={onClose}>取消</button>
                <button className="skill-config-save" onClick={() => setStep("credentials")}>下一步：填写应用密钥<ArrowRight size={14} /></button>
              </div>
            </div>
          )}

          {step === "credentials" && (
            <div className="wizard-section">
              <h3><KeyRound size={17} />应用密钥</h3>
              {credentialsConfigured && <p className="wizard-note">检测到已配置应用密钥，留空即保持不变，可直接下一步。</p>}
              <div className="skill-config-fields">
                <div className="skill-config-field">
                  <label htmlFor="wizard-app-key">App Key<span className="skill-config-required">*</span></label>
                  <input
                    id="wizard-app-key"
                    type="text"
                    value={appKey}
                    placeholder={credentialsConfigured ? "已配置，留空保持不变" : "TikTok Shop Partner Center 的 App Key"}
                    onChange={(event) => setAppKey(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="skill-config-field">
                  <label htmlFor="wizard-app-secret">App Secret<span className="skill-config-required">*</span></label>
                  <input
                    id="wizard-app-secret"
                    type="password"
                    value={appSecret}
                    placeholder={secretConfigured ? "已配置，留空保持不变" : "TikTok Shop Partner Center 的 App Secret"}
                    onChange={(event) => setAppSecret(event.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div className="skill-config-field">
                  <label htmlFor="wizard-service-id">Service ID</label>
                  <input
                    id="wizard-service-id"
                    type="text"
                    value={serviceId}
                    placeholder="应用市场服务 ID（纯数字），决定授权页面"
                    onChange={(event) => setServiceId(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
              <p className="wizard-note">Service ID 在 Partner Center 该应用「应用市场」服务的授权链接里（service_id= 后面那串数字）。保存后授权链接会使用这里填写的 Service ID，优先于 .env 中的旧配置。</p>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={() => setStep("guide")}>上一步</button>
                <button className="skill-config-save" disabled={saving} onClick={() => void saveCredentials()}>
                  {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                  <span>{saving ? "正在保存" : "保存并继续"}</span>
                </button>
              </div>
            </div>
          )}

          {step === "authorize" && (
            <div className="wizard-section">
              <h3><ExternalLink size={17} />前往 TikTok 授权</h3>
              <ol className="wizard-checklist">
                <li>点击下方按钮后会跳转到 TikTok 授权页。</li>
                <li><strong>用要绑定的那家公司的卖家账号</strong>登录并确认授权。</li>
                <li>授权完成后会自动返回本系统，新店铺出现在下方绑定列表中。</li>
              </ol>
              <p className="wizard-note">要绑定多个卖家账号（不同主体），为每个账号各走一次授权即可；同一账号下的多国店铺会随一次授权一起进入系统。</p>
              <p className="wizard-note">如果授权页提示「你店铺所在地区不可用 / 请切换 Self-operated (POP) 账号」，说明当前登录的卖家账号和 App Service ID 不匹配：回到上一步核对 Service ID，或用对应地区的卖家账号登录后再授权。</p>
              <div className="wizard-actions">
                <button className="skill-config-cancel" onClick={() => setStep("credentials")}>上一步</button>
                <button className="primary-button" onClick={() => window.location.assign(API_BASE + "/api/tiktok/authorize")}>
                  去授权<ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
