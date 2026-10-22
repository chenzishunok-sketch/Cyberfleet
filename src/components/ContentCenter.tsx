import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  Play,
  RefreshCcw,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { ContentAsset, ContentAssetType, ContentOverview, ContentTask } from "../../shared/content";
import { AGNES_IMAGE_MODEL, contentImageDimensions } from "../../shared/content";
import { api } from "../api";

export type ContentSection = "create" | "assets" | "tasks";
type CreateMode = ContentAssetType;

interface ContentCenterProps { section: ContentSection }

const modeCopy = {
  text: { label: "文字", icon: FileText, placeholder: "输入商品信息、目标受众和创作要求…" },
  image: { label: "图片", icon: ImageIcon, placeholder: "描述画面、商品、场景、构图和需要突出的卖点…" },
  video: { label: "视频", icon: Film, placeholder: "描述镜头、商品动作、场景、节奏和希望传达的卖点…" },
} as const;

function readImages(files: FileList | null, maximum: number): Promise<string[]> {
  const selected = Array.from(files ?? []).slice(0, maximum);
  return Promise.all(selected.map((file) => new Promise<string>((resolve, reject) => {
    if (file.size > 6 * 1024 * 1024) return reject(new Error(`${file.name} 超过 6MB。`));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}。`));
    reader.readAsDataURL(file);
  })));
}

async function extractVideoFrames(file: File): Promise<string[]> {
  if (file.size > 120 * 1024 * 1024) throw new Error(`${file.name} 超过 120MB。`);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("无法读取参考视频。"));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("参考视频时长不正确。");
    const canvas = document.createElement("canvas");
    const maximumWidth = 1080;
    const scale = Math.min(1, maximumWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法截取参考视频画面。");
    const capture = async (time: number) => {
      video.currentTime = time;
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("参考视频画面读取失败。"));
      });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", .92);
    };
    return [await capture(Math.min(.15, video.duration / 4)), await capture(Math.max(.15, video.duration - .15))];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function taskLabel(status: ContentTask["status"]) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "in_progress") return "生成中";
  return "排队中";
}

export function ContentCenter({ section }: ContentCenterProps) {
  const [overview, setOverview] = useState<ContentOverview>({ configured: false, assets: [], tasks: [] });
  const [mode, setMode] = useState<CreateMode>("image");
  const [assetFilter, setAssetFilter] = useState<"all" | ContentAssetType>("all");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [sku, setSku] = useState("");
  const [language, setLanguage] = useState("泰语");
  const [textKind, setTextKind] = useState<"title" | "listing" | "script">("listing");
  const [ratio, setRatio] = useState("9:16");
  const [imageSize, setImageSize] = useState("2K");
  const [resolution, setResolution] = useState("720p");
  const [duration, setDuration] = useState(5);
  const [uploads, setUploads] = useState<string[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [result, setResult] = useState<ContentAsset>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (quiet = false) => {
    try {
      const data = await api.contentOverview();
      setOverview(data);
      if (!quiet) setError(undefined);
    } catch (loadError) {
      if (!quiet) setError(loadError instanceof Error ? loadError.message : "无法读取内容中心。");
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const pending = overview.tasks.some((task) => task.status === "queued" || task.status === "in_progress");
    if (!pending) return;
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [overview.tasks]);

  useEffect(() => {
    setUploads([]);
    setSelectedAssetIds([]);
    setResult(undefined);
    setError(undefined);
    setRatio(mode === "image" ? "1:1" : "9:16");
  }, [mode]);

  const imageAssets = overview.assets.filter((asset) => asset.type === "image");
  const visibleAssets = overview.assets.filter((asset) => assetFilter === "all" || asset.type === assetFilter);
  const latestTasks = overview.tasks.slice(0, 100);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const common = { title: title.trim() || undefined, prompt: prompt.trim(), project: project.trim() || undefined, sku: sku.trim() || undefined };
      if (mode === "text") {
        const response = await api.createTextContent({ ...common, kind: textKind, language });
        setResult(response.asset);
      } else if (mode === "image") {
        const response = await api.createImageContent({ ...common, ratio, size: imageSize, ...(uploads.length ? { images: uploads } : {}) });
        setResult(response.asset);
      } else {
        await api.createVideoContent({ ...common, ratio, resolution, duration, ...(selectedAssetIds.length ? { assetIds: selectedAssetIds } : {}), ...(uploads.length ? { images: uploads } : {}) });
      }
      await load(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "生成失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const writeVideoScript = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.createTextContent({
        title: title.trim() ? `${title.trim()}脚本` : undefined,
        prompt: prompt.trim(), project: project.trim() || undefined, sku: sku.trim() || undefined,
        kind: "script", language,
      });
      setPrompt(response.asset.content ?? prompt);
      setResult(response.asset);
      await load(true);
    } catch (scriptError) {
      setError(scriptError instanceof Error ? scriptError.message : "脚本生成失败。");
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    try {
      const fileList = Array.from(files ?? []);
      const video = mode === "video" ? fileList.find((file) => file.type.startsWith("video/")) : undefined;
      setUploads(video ? await extractVideoFrames(video) : await readImages(files, mode === "video" ? 2 : 4));
      setError(undefined);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "图片读取失败。");
    }
  };

  return (
    <main className="page-content content-center">
      <header className="content-header">
        <div><h1>{section === "create" ? "内容创作" : section === "assets" ? "内容资产" : "生成任务"}</h1><p>{section === "create" ? "从商品资料到文字、图片和视频，所有成品自动进入本地资产库。" : section === "assets" ? "集中保存并查找已经生成的文字、图片和视频。" : "查看图片和视频生成进度，失败任务会保留原因。"}</p></div>
        <span className={`content-provider ${overview.configured ? "is-ready" : ""}`}><i />{overview.configured ? "Agnes 已连接" : "等待配置"}</span>
      </header>

      {error && <div className="content-error"><XCircle size={17} /><span>{error}</span><button onClick={() => setError(undefined)}>关闭</button></div>}

      {section === "create" && (
        <>
          <div className="content-mode-tabs" role="tablist" aria-label="创作类型">
            {(Object.keys(modeCopy) as CreateMode[]).map((item) => {
              const Icon = modeCopy[item].icon;
              return <button key={item} className={mode === item ? "selected" : ""} onClick={() => setMode(item)}><Icon size={16} /><span>{modeCopy[item].label}</span></button>;
            })}
          </div>

          <section className="content-studio">
            <div className="content-compose">
              <div className="content-meta-row">
                <label><span>项目</span><input value={project} onChange={(event) => setProject(event.target.value)} placeholder="例如：泰国新品首发" /></label>
                <label><span>商品 SKU</span><input value={sku} onChange={(event) => setSku(event.target.value)} placeholder="可选" /></label>
                <label><span>素材名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="自动使用创作要求" /></label>
              </div>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={modeCopy[mode].placeholder} aria-label="创作要求" />

              {(mode === "image" || mode === "video") && (
                <div className="content-reference-row">
                  <input ref={inputRef} hidden type="file" accept={mode === "video" ? "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" : "image/jpeg,image/png,image/webp"} multiple onChange={(event) => void handleFiles(event.target.files)} />
                  <button className="content-attach" onClick={() => inputRef.current?.click()}><Paperclip size={16} /><span>{mode === "video" ? "上传首尾帧或参考视频" : "上传参考图"}</span></button>
                  {uploads.map((image, index) => <span className="content-upload-thumb" key={`${image.slice(-20)}-${index}`}><img src={image} alt={`参考图 ${index + 1}`} /><b>{mode === "video" ? index === 0 ? "首帧" : "尾帧" : index + 1}</b></span>)}
                  {uploads.length > 0 && <button className="content-clear-upload" onClick={() => setUploads([])}>清除</button>}
                </div>
              )}

              {mode === "video" && imageAssets.length > 0 && (
                <div className="content-reference-assets">
                  <span>也可以从资产库选择关键帧</span>
                  <div>{imageAssets.slice(0, 8).map((asset) => {
                    const selectedIndex = selectedAssetIds.indexOf(asset.id);
                    return <button key={asset.id} className={selectedIndex >= 0 ? "selected" : ""} onClick={() => setSelectedAssetIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : current.length < 2 ? [...current, asset.id] : current)}><img src={asset.url} alt={asset.title} />{selectedIndex >= 0 && <b>{selectedIndex === 0 ? "首帧" : "尾帧"}</b>}</button>;
                  })}</div>
                </div>
              )}

              <div className="content-controls">
                {mode === "text" ? <>
                  <label><span>类型</span><select value={textKind} onChange={(event) => setTextKind(event.target.value as typeof textKind)}><option value="title">商品标题</option><option value="listing">卖点 Listing</option><option value="script">短视频脚本</option></select></label>
                  <label><span>语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option>泰语</option><option>中文</option><option>英语</option></select></label>
                </> : <>
                  <label><span>比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{(mode === "image" ? ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "21:9"] : ["9:16", "16:9", "1:1", "4:3", "3:4"]).map((item) => <option key={item}>{item}</option>)}</select></label>
                  {mode === "image" ? <>
                    <label><span>图片模型</span><span>{AGNES_IMAGE_MODEL}</span></label>
                    <label><span>清晰度</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>{["1K", "2K", "3K", "4K"].map((item) => <option key={item}>{item}</option>)}</select></label>
                    <span>{contentImageDimensions(ratio, imageSize)} 像素</span>
                  </> : <>
                    <label><span>画质</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}>{["480p", "720p", "1080p"].map((item) => <option key={item}>{item}</option>)}</select></label>
                    <label><span>时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{[3, 5, 10, 18].map((item) => <option key={item} value={item}>{item} 秒</option>)}</select></label>
                  </>}
                </>}
                {mode === "video" && <button className="content-script-button" disabled={!prompt.trim() || busy} onClick={() => void writeVideoScript()}><FileText size={16} /><span>先写脚本</span></button>}
                <button className="content-generate" disabled={!prompt.trim() || busy || (mode !== "text" && !overview.configured)} onClick={() => void submit()}>{busy ? <LoaderCircle size={17} className="spin" /> : mode === "video" ? <Play size={17} /> : <Sparkles size={17} />}<span>{busy ? "正在提交" : mode === "video" ? "生成视频" : "开始生成"}</span></button>
              </div>
            </div>

            <aside className="content-result">
              <div className="content-result-heading"><span>本次结果</span>{result?.url && <a href={result.url} download title="下载素材"><Download size={16} /></a>}</div>
              {!result ? <div className="content-result-empty">{busy ? <><LoaderCircle size={24} className="spin" /><span>正在生成，请保持页面打开</span></> : <><Sparkles size={24} /><span>生成结果会显示在这里</span></>}</div> : result.type === "text" ? <pre>{result.content}</pre> : result.type === "image" ? <img src={result.url} alt={result.title} /> : <video src={result.url} controls />}
              {mode === "video" && !result && overview.tasks.some((task) => task.type === "video" && !["completed", "failed"].includes(task.status)) && <div className="content-video-note"><Clock3 size={15} /><span>视频正在后台生成，可以前往“生成任务”查看进度。</span></div>}
            </aside>
          </section>
        </>
      )}

      {section === "assets" && (
        <section className="content-library">
          <div className="content-library-toolbar"><div>{(["all", "text", "image", "video"] as const).map((item) => <button key={item} className={assetFilter === item ? "selected" : ""} onClick={() => setAssetFilter(item)}>{item === "all" ? "全部" : modeCopy[item].label}</button>)}</div><span>{visibleAssets.length} 项素材</span></div>
          {visibleAssets.length ? <div className="content-asset-grid">{visibleAssets.map((asset) => <AssetCard key={asset.id} asset={asset} />)}</div> : <div className="content-empty"><ImageIcon size={26} /><strong>还没有内容资产</strong><span>完成一次创作后，素材会自动保存在这里。</span></div>}
        </section>
      )}

      {section === "tasks" && (
        <section className="content-tasks">
          <div className="content-task-toolbar"><span>{latestTasks.length} 个生成任务</span><button onClick={() => void load()}><RefreshCcw size={15} />刷新</button></div>
          {latestTasks.length ? latestTasks.map((task) => <TaskRow key={task.id} task={task} asset={overview.assets.find((asset) => asset.id === task.assetId)} />) : <div className="content-empty"><Clock3 size={26} /><strong>还没有生成任务</strong><span>开始创作后，可以在这里查看每一步状态。</span></div>}
        </section>
      )}
    </main>
  );
}

function AssetCard({ asset }: { asset: ContentAsset }) {
  const Icon = modeCopy[asset.type].icon;
  return <article className={`content-asset-card content-asset-card--${asset.type}`}>
    <div className="content-asset-preview">{asset.type === "text" ? <><FileText size={26} /><p>{asset.content}</p></> : asset.type === "image" ? <img src={asset.url} alt={asset.title} /> : <video src={asset.url} controls preload="metadata" />}</div>
    <div className="content-asset-info"><span><Icon size={14} />{modeCopy[asset.type].label}</span><strong>{asset.title}</strong><small>{asset.project || "未归类"}{asset.sku ? ` · ${asset.sku}` : ""} · {formatTime(asset.createdAt)}</small></div>
    {asset.url && <a href={asset.url} download title="下载"><Download size={16} /></a>}
  </article>;
}

function TaskRow({ task, asset }: { task: ContentTask; asset?: ContentAsset }) {
  const Icon = modeCopy[task.type].icon;
  const StatusIcon = task.status === "completed" ? CheckCircle2 : task.status === "failed" ? XCircle : LoaderCircle;
  return <article className="content-task-row">
    <span className="content-task-icon"><Icon size={18} /></span>
    <div className="content-task-copy"><strong>{task.title}</strong><span>{modeCopy[task.type].label} · {formatTime(task.updatedAt)}</span>{task.error && <small>{task.error}</small>}</div>
    <div className="content-task-progress"><div><i style={{ width: `${Math.max(3, task.progress)}%` }} /></div><span>{Math.round(task.progress)}%</span></div>
    <span className={`content-task-status is-${task.status}`}><StatusIcon size={14} className={task.status === "in_progress" ? "spin" : ""} />{taskLabel(task.status)}</span>
    {asset?.url ? <a href={asset.url} download title="下载成品"><Download size={16} /></a> : <span className="content-task-spacer" />}
  </article>;
}
