import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Copy, Folder, FolderOpen, KeyRound, Play, Plus, Square, X } from "lucide-react";
import { canStart, canStop, connectionUrl, mcpRequest, type FolderListing, type MCPService, type MCPServicesResponse } from "./mcpServices";
import "./mcp-services.css";

const STATES = { starting: "正在启动", stopping: "正在停止", running: "运行中", stopped: "已停止", error: "需要处理" };

function FolderPicker({ initial, onChoose, onClose }: { initial: string; onChoose: (path: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initial);
  const [address, setAddress] = useState(initial);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    mcpRequest<FolderListing>(`folders?path=${encodeURIComponent(path)}`, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setListing(value); setAddress(value.path); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法打开文件夹"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  return <dialog ref={dialog} className="mcp-folder-dialog" aria-labelledby="mcp-folder-title" onCancel={onClose}>
    <header><h2 id="mcp-folder-title">选择工作文件夹</h2><button type="button" aria-label="关闭文件夹选择" onClick={onClose}><X size={18}/></button></header>
    <form className="mcp-folder-address" onSubmit={event => { event.preventDefault(); setPath(address); setAttempt(value => value + 1); }}>
      <button type="button" aria-label="上一级文件夹" disabled={!listing?.parent || loading} onClick={() => setPath(listing!.parent!)}><ArrowLeft size={16}/></button>
      <input aria-label="文件夹路径" value={address} onChange={event => setAddress(event.target.value)} placeholder="输入绝对路径或浏览下方文件夹"/>
      <button type="submit" disabled={loading}>前往</button>
    </form>
    <div className="mcp-folder-roots">{listing?.roots.map(root => <button type="button" key={root.path} onClick={() => setPath(root.path)}><Folder size={14}/>{root.name}</button>)}</div>
    <div className="mcp-folder-list" aria-busy={loading}>
      {loading ? <p role="status">正在读取文件夹…</p> : error ? <p role="alert">{error}</p> : listing?.folders.length ? listing.folders.map(folder => <button type="button" key={`${folder.name}:${folder.path}`} onClick={() => setPath(folder.path)}><Folder size={17}/><span>{folder.name}</span><ChevronRight size={14}/></button>) : <p>这个文件夹没有可浏览的子文件夹。</p>}
    </div>
    <footer><div>{listing && !loading && !error && <><p>{listing.path}</p>{listing.reason && <small>{listing.reason}</small>}{listing.truncated && <small>仅显示部分文件夹，也可以在上方输入完整路径。</small>}</>}</div>
      <button type="button" className="mcp-primary" disabled={loading || !!error || !listing?.selectable} onClick={() => listing && onChoose(listing.path)}>选择此文件夹</button></footer>
  </dialog>;
}

function ServiceCard({ service, onAction }: { service: MCPService; onAction: (id: string, action: "start" | "stop") => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [password, setPassword] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const url = connectionUrl(service.url);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setFeedback(`${label}已复制`); }
    catch { setFeedback("无法访问剪贴板，请选中文字复制。"); }
  }
  async function action(value: "start" | "stop") {
    setPending(true); setFeedback(""); setPassword(null);
    try { await onAction(service.id, value); }
    catch (reason) { setFeedback(reason instanceof Error ? reason.message : "操作未完成"); }
    finally { setPending(false); }
  }
  async function revealPassword() {
    if (password !== null) { setPassword(null); return; }
    try { const result = await mcpRequest<{ password: string }>("password", { id: service.id }); setPassword(result.password); }
    catch (reason) { setFeedback(reason instanceof Error ? reason.message : "口令读取失败"); }
  }
  async function showLogs() {
    if (logs !== null) { setLogs(null); return; }
    try { const result = await mcpRequest<{ text: string }>(`logs?id=${encodeURIComponent(service.id)}`); setLogs(result.text || "还没有日志。"); }
    catch (reason) { setFeedback(reason instanceof Error ? reason.message : "日志读取失败"); }
  }
  return <article className="mcp-service-card" aria-label={`${service.name} MCP 服务`}>
    <header><div><h2>{service.name}</h2><p><FolderOpen size={13}/><span>{service.workspace || "工作区不可用"}</span></p></div><span className="mcp-state" data-state={service.status}><i/>{STATES[service.status]}</span></header>
    <div className="mcp-service-address"><label htmlFor={`url-${service.id}`}>ChatGPT 连接地址</label><div><input id={`url-${service.id}`} aria-label={`${service.name} 连接地址`} readOnly value={url ?? ""} placeholder={service.busy ? "正在建立 HTTPS 通道…" : "启动服务后生成 HTTPS 地址"} onFocus={event => event.target.select()}/><button type="button" aria-label={`复制 ${service.name} 连接地址`} disabled={!url} onClick={() => url && void copy(url, "连接地址")}><Copy size={15}/></button></div></div>
    <div className="mcp-service-actions"><div><button type="button" disabled={pending || !canStart(service)} onClick={() => void action("start")}><Play size={13}/>启动</button><button type="button" disabled={pending || !canStop(service)} onClick={() => void action("stop")}><Square size={12}/>停止</button></div><button type="button" onClick={() => void revealPassword()} aria-expanded={password !== null}><KeyRound size={14}/>{password === null ? "授权口令" : "收起口令"}</button><button type="button" onClick={() => void showLogs()} aria-expanded={logs !== null}>{logs === null ? "日志" : "收起日志"}</button></div>
    {password !== null && <div className="mcp-password"><p>仅在此服务的 OAuth 授权页使用，不是你的 ChatGPT 密码。</p><div><input aria-label={`${service.name} 授权口令`} readOnly value={password} onFocus={event => event.target.select()}/><button type="button" onClick={() => void copy(password, "授权口令")}><Copy size={14}/>复制</button></div></div>}
    {service.error && <p className="mcp-error" role="alert">{service.error}</p>}
    {feedback && <p className="mcp-feedback" role="status">{feedback}</p>}
    {logs !== null && <pre className="mcp-logs" tabIndex={0}>{logs}</pre>}
  </article>;
}

export function MCPServicesPanel({ active }: { active: boolean }) {
  const [response, setResponse] = useState<MCPServicesResponse | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [picker, setPicker] = useState(false);
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (cancelled) return;
      if (document.visibilityState !== "visible" || !document.getElementById("mcp-services-panel")?.getClientRects().length) { timer = setTimeout(poll, 3000); return; }
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const data = await mcpRequest<MCPServicesResponse>("services", undefined, controller.signal);
        if (!cancelled) { setResponse(data); setError(""); }
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取服务状态"); }
      finally { clearTimeout(timeout); if (!cancelled) timer = setTimeout(poll, 3000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [active, revision]);
  async function action(id: string, operation: "start" | "stop") {
    await mcpRequest("action", { id, action: operation });
    setRevision(value => value + 1);
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setFormError("");
    try {
      const result = await mcpRequest<{ existing?: boolean }>("services", { name, workspace });
      setCreating(false); setWorkspace(""); setName("");
      setNotice(result.existing ? "已找到这个文件夹的服务，继续使用现有连接。" : "服务正在启动，HTTPS 地址就绪后会显示在下方。");
      setRevision(value => value + 1);
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : "服务未能创建"); }
    finally { setSaving(false); }
  }
  return <section id="mcp-services-panel" className="mcp-services-panel" hidden={!active} aria-label="MCP 服务">
    <div className="mcp-intro"><div><h2>让 ChatGPT 使用你的工作文件夹</h2><p>选择原文件夹，启动服务，再把连接地址添加到网页 ChatGPT。</p></div><button type="button" className="mcp-primary" disabled={!response?.enabled || !response.runtime.ready} onClick={() => { setCreating(value => !value); setFormError(""); }}><Plus size={15}/>添加服务</button></div>
    {error && <p className="mcp-error" role="alert">{error} {response && "显示上次读取的状态。"}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!response ? <p className="mcp-empty" role="status">正在读取 MCP 服务…</p> : !response.enabled ? <p className="mcp-empty">在本机配置中启用 MCP 服务管理后，即可选择工作文件夹。</p> : <>
      {!response.runtime.ready && <p className="mcp-error" role="alert">{response.runtime.error}</p>}
      {creating && <form className="mcp-create" onSubmit={event => void create(event)}>
        <div className="mcp-create-fields"><label>服务名称<input aria-label="服务名称" value={name} maxLength={80} required onChange={event => setName(event.target.value)} placeholder="例如：我的项目"/></label><label>工作文件夹<div className="mcp-folder-control"><input aria-label="选中的工作文件夹" value={workspace} readOnly placeholder="选择本机上的文件夹"/><button type="button" onClick={() => setPicker(true)}><FolderOpen size={15}/>选择文件夹</button></div></label></div>
        <p className="mcp-scope">将允许 ChatGPT 读写这个原文件夹并运行开发命令，修改直接落盘。HTTPS 连接通过 Cloudflare 转发，使用独立 OAuth 口令授权。</p>
        <div className="mcp-create-footer"><span>关闭页面后服务继续运行，可随时在下方停止。</span><button type="button" onClick={() => setCreating(false)} disabled={saving}>取消</button><button type="submit" className="mcp-primary" disabled={saving || !workspace || !name.trim()}>{saving ? "正在创建…" : "启动服务"}</button></div>
        {formError && <p className="mcp-error" role="alert">{formError}</p>}
      </form>}
      {notice && <p className="mcp-feedback" role="status">{notice}</p>}
      <div className="mcp-service-list">{response.services.map(service => <ServiceCard key={service.id} service={service} onAction={action}/>)}</div>
      {!response.services.length && !creating && <p className="mcp-empty">还没有服务。添加一个工作文件夹开始使用。</p>}
      <details className="mcp-connect-guide"><summary>如何连接网页 ChatGPT</summary><ol><li>在 ChatGPT 设置中开启 Developer mode，然后在应用／插件页面创建开发者应用。</li><li>填写服务名称和上方的 HTTPS 连接地址。认证选择 OAuth，客户端注册选择 DCR。</li><li>跳转到此服务的授权页面后，填入对应的授权口令。</li><li>在新对话中启用这个应用，先请它调用 server_info 核对工作文件夹，再开始操作。</li></ol><p>临时 HTTPS 通道重启后地址会改变，需要更新 ChatGPT 连接；授权过期时重新连接。服务端启动成功不代表已在 ChatGPT 完成授权。</p><p>采用现有 safe 模式。macOS 上它不是完整系统沙箱；只连接愿意交给 ChatGPT 操作的目录。</p><a href="https://developers.openai.com/api/docs/guides/developer-mode" target="_blank" rel="noreferrer">OpenAI 接入说明 ↗</a></details>
    </>}
    {picker && <FolderPicker initial={workspace} onClose={() => setPicker(false)} onChoose={path => { setWorkspace(path); if (!name.trim()) setName(path.split("/").filter(Boolean).at(-1) ?? "我的项目"); setPicker(false); }}/>}
  </section>;
}
