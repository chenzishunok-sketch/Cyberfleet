import { useState } from "react";
import {
  X,
  Package,
  Settings,
  Power,
  PowerOff,
  Trash2,
  Check,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import type { SkillDefinition, SkillStatus, SkillsCatalogResponse } from "../../shared/contracts";
import { api } from "../api";

interface SkillManagerProps {
  catalog: SkillsCatalogResponse;
  onClose: () => void;
  onCatalogChange: (catalog: SkillsCatalogResponse) => void;
}

const categoryLabels: Record<string, string> = {
  collection: "采集上架",
  fulfillment: "履约物流",
  analytics: "经营分析",
  custom: "自定义",
};

const categoryIcons: Record<string, string> = {
  collection: "📦",
  fulfillment: "🚚",
  analytics: "📊",
  custom: "🔧",
};

function SkillCard({
  skill,
  status,
  onConfig,
  onToggle,
  onInstall,
  onUninstall,
}: {
  skill: SkillDefinition;
  status: SkillStatus;
  onConfig: () => void;
  onToggle: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const isInstalled = status.installed || skill.builtin;
  const isEnabled = status.enabled;
  const isConfigured = status.configured;
  const sourceLabel = status.configSource === "oauth" ? "OAuth 授权"
    : status.configSource === "skill" ? "设置页配置"
      : status.configSource === "env" ? ".env 配置"
        : undefined;

  return (
    <div className={`skill-card ${!isInstalled ? "skill-card--uninstalled" : ""} ${!isEnabled ? "skill-card--disabled" : ""}`}>
      <div className="skill-card-header">
        <div className="skill-card-icon">
          {categoryIcons[skill.category] ?? "📦"}
        </div>
        <div className="skill-card-info">
          <div className="skill-card-name">
            {skill.name}
            {skill.builtin && <span className="skill-badge-builtin">内置</span>}
            {!isConfigured && isInstalled && <span className="skill-badge-unconfigured">未配置</span>}
            {status.connectionState === "connected" && <span className="skill-badge-connected">已连接</span>}
            {status.connectionState === "configured" && <span className="skill-badge-connected">已配置</span>}
          </div>
          <div className="skill-card-desc">{skill.description}</div>
          <div className="skill-card-meta">
            <span>v{skill.version}</span>
            <span>{categoryLabels[skill.category] ?? skill.category}</span>
            <span>{skill.scenes.length} 个场景</span>
            {sourceLabel && <span>{sourceLabel}</span>}
          </div>
        </div>
      </div>

      <div className="skill-card-actions">
        {!isInstalled ? (
          <button className="skill-action-btn skill-action-btn--primary" onClick={onInstall}>
            <Package size={14} />
            <span>安装</span>
          </button>
        ) : (
          <>
            {skill.configFields.length > 0 && (
              <button
                className={`skill-action-btn ${!isConfigured ? "skill-action-btn--warning" : ""}`}
                onClick={onConfig}
                title="配置"
              >
                <Settings size={14} />
                <span>配置</span>
              </button>
            )}
            <button
              className={`skill-action-btn ${isEnabled ? "skill-action-btn--active" : ""}`}
              onClick={onToggle}
              title={isEnabled ? "禁用" : "启用"}
            >
              {isEnabled ? <Power size={14} /> : <PowerOff size={14} />}
              <span>{isEnabled ? "已启用" : "已禁用"}</span>
            </button>
            {!skill.builtin && (
              <button className="skill-action-btn skill-action-btn--danger" onClick={onUninstall} title="卸载">
                <Trash2 size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConfigPanel({
  skill,
  status,
  onSave,
  onCancel,
}: {
  skill: SkillDefinition;
  status: SkillStatus;
  onSave: (config: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of skill.configFields) {
      initial[field.key] = field.type === "password" ? "" : status.config[field.key] ?? "";
    }
    return initial;
  });

  return (
    <div className="skill-config-panel">
      <div className="skill-config-header">
        <h4>配置 {skill.name}</h4>
        <button className="icon-button" aria-label="关闭配置" title="关闭配置" onClick={onCancel}><X size={16} /></button>
      </div>
      <div className="skill-config-fields">
        {skill.configFields.map((field) => (
          <div key={field.key} className="skill-config-field">
            <label htmlFor={`skill-config-${field.key}`}>
              {field.label}
              {field.required && <span className="skill-config-required">*</span>}
            </label>
            <input
              id={`skill-config-${field.key}`}
              type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
              value={values[field.key] ?? ""}
              placeholder={field.type === "password" && status.config[field.key] ? "已配置，留空保持不变" : field.placeholder}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="skill-config-footer">
        <button className="skill-config-cancel" onClick={onCancel}>取消</button>
        <button className="skill-config-save" onClick={() => onSave(values)}>
          <Check size={14} />
          <span>保存配置</span>
        </button>
      </div>
    </div>
  );
}

export function SkillManager({ catalog, onClose, onCatalogChange }: SkillManagerProps) {
  const [configuringSkillId, setConfiguringSkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInstall = async (skillId: string) => {
    setLoading(skillId);
    setError(null);
    try {
      await api.installSkill(skillId);
      const updated = await api.skills();
      onCatalogChange(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "安装失败");
    } finally {
      setLoading(null);
    }
  };

  const handleUninstall = async (skillId: string) => {
    setLoading(skillId);
    setError(null);
    try {
      await api.uninstallSkill(skillId);
      const updated = await api.skills();
      onCatalogChange(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "卸载失败");
    } finally {
      setLoading(null);
    }
  };

  const handleToggle = async (skillId: string, currentlyEnabled: boolean) => {
    setLoading(skillId);
    setError(null);
    try {
      if (currentlyEnabled) {
        await api.disableSkill(skillId);
      } else {
        await api.enableSkill(skillId);
      }
      const updated = await api.skills();
      onCatalogChange(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setLoading(null);
    }
  };

  const handleSaveConfig = async (skillId: string, config: Record<string, string>) => {
    setLoading(skillId);
    setError(null);
    try {
      await api.updateSkillConfig(skillId, config);
      const updated = await api.skills();
      onCatalogChange(updated);
      setConfiguringSkillId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存配置失败");
    } finally {
      setLoading(null);
    }
  };

  const configuringSkill = configuringSkillId
    ? catalog.skills.find((s) => s.id === configuringSkillId)
    : null;
  const configuringStatus = configuringSkillId
    ? catalog.statuses.find((s) => s.id === configuringSkillId)
    : null;

  return (
    <div className="skill-manager-backdrop" onClick={onClose}>
      <div className="skill-manager" onClick={(e) => e.stopPropagation()}>
        <div className="skill-manager-header">
          <div>
            <h2>Skill 市场</h2>
            <p>管理已安装的 Skill，配置 API 凭据，启用或禁用能力模块。</p>
          </div>
          <button className="icon-button" aria-label="关闭 Skill 管理" title="关闭 Skill 管理" onClick={onClose}><X size={20} /></button>
        </div>

        {error && (
          <div className="skill-manager-error">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button onClick={() => setError(null)}><X size={14} /></button>
          </div>
        )}

        <div className="skill-manager-body">
          {catalog.skills.map((skill) => {
            const status = catalog.statuses.find((s) => s.id === skill.id);
            if (!status) return null;
            return (
              <SkillCard
                key={skill.id}
                skill={skill}
                status={status}
                onConfig={() => setConfiguringSkillId(skill.id)}
                onToggle={() => handleToggle(skill.id, status.enabled)}
                onInstall={() => handleInstall(skill.id)}
                onUninstall={() => handleUninstall(skill.id)}
              />
            );
          })}
        </div>

        {configuringSkill && configuringStatus && (
          <ConfigPanel
            skill={configuringSkill}
            status={configuringStatus}
            onSave={(config) => handleSaveConfig(configuringSkill.id, config)}
            onCancel={() => setConfiguringSkillId(null)}
          />
        )}
      </div>
    </div>
  );
}
