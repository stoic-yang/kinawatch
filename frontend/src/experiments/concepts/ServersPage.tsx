import { useEffect, useState } from "react";
import { MCPServicesPanel } from "./MCPServicesPanel";
import { Pause, Play, RefreshCw, Search, Server } from "lucide-react";
import { bytes, duration, filterProcesses, gpuMemory, hostStatus, metric, percent, type Metric, type ProcessFilter, type ServerHost } from "./serverMonitor";
import { useServerMonitor } from "./useServerMonitor";
import "./servers.css";

const STATUS = { online: "在线", offline: "连接中断", stale: "数据已过期", connecting: "连接中" };

function Meter({ label, value, detail }: { label: string; value: Metric; detail: string }) {
  return <div className="server-meter">
    <div><span>{label}</span><strong>{metric(value)}{value !== null && <small>%</small>}</strong></div>
    <div className="server-meter-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}/></div>
    <p>{detail}</p>
  </div>;
}

function HostCard({ host, elapsed, failed }: { host: ServerHost; elapsed: number; failed: boolean }) {
  const data = host.data;
  const status = hostStatus(host, elapsed, failed);
  const age = host.age_seconds === null ? null : Math.floor(host.age_seconds + elapsed);
  return <article className="server-card" data-status={status} aria-label={`${host.alias} 资源状态`}>
    <header><div><h2>{host.alias}</h2><p>{data?.hostname ?? "等待服务器数据"} · {host.route === "直连" ? "直连" : `经 ${host.route}`}</p></div>
      <span className="server-status" data-status={status}><i/>{STATUS[status]}</span></header>
    {data ? <>
      <div className="server-resources">
        <Meter label={data.cpu_scope === "cgroup" ? "CPU · 容器" : "CPU"} value={data.cpu} detail={data.cpu_scope === "cgroup" ? `${metric(data.cores, Number.isInteger(data.cores) ? 0 : 2)} 核配额 · GPU 共享` : `${metric(data.cores, 0)} 核 · Load ${data.load.join(" / ")}`}/>
        <Meter label={data.memory_scope === "cgroup" ? "内存 · 容器" : "内存"} value={percent(data.memory.used, data.memory.total)} detail={`${bytes(data.memory.used)} / ${bytes(data.memory.total)}${data.memory_scope === "cgroup" ? " · 含缓存" : ""}`}/>
      </div>
      <div className="server-gpus">{data.gpus.map(gpu => <section className="server-resource-section" key={gpu.index} aria-label={`GPU ${gpu.index}`}>
        <div className="server-gpu-title"><strong>GPU {gpu.index}</strong><span>{gpu.name}</span></div>
        <div className="server-resources">
          <Meter label="GPU 利用率" value={gpu.util} detail={`${metric(gpu.temperature, 0)} °C · ${metric(gpu.power, 0)} W`}/>
          <Meter label="显存" value={percent(gpu.used_mib, gpu.total_mib)} detail={`${gpuMemory(gpu.used_mib)} / ${gpuMemory(gpu.total_mib)}`}/>
        </div>
      </section>)}{!data.gpus.length && <p className="server-no-gpu">{data.errors.length ? "GPU 数据暂时不可用" : "未检测到 NVIDIA GPU"}</p>}</div>
      <section className="server-resource-section" aria-label="磁盘与 Swap">
        <div className="server-resources">
          {data.disks.map(disk => <Meter key={disk.path} label={`磁盘 ${disk.path}`} value={percent(disk.used, disk.total)} detail={`${bytes(disk.used)} / ${bytes(disk.total)}`}/>)}
          <Meter label="Swap" value={percent(data.swap.used, data.swap.total)} detail={data.swap.total === 0 ? "未启用" : `${bytes(data.swap.used)} / ${bytes(data.swap.total)}`}/>
        </div>
      </section>
      <p className="server-uptime">{data.cpu_scope === "cgroup" || data.memory_scope === "cgroup" ? "宿主机已运行" : "已运行"} {duration(data.uptime)}</p>
    </> : <div className="server-waiting"><Server size={25}/><p>{status === "connecting" ? "正在建立 SSH 连接…" : "暂时无法连接服务器"}</p></div>}
    {(host.error || data?.errors.length) ? <div className="server-errors" role="status">{host.error && <p>{host.error}</p>}{data?.errors.map((error, i) => <p key={i}>{error}</p>)}</div> : null}
    <footer>{age === null ? "尚未收到样本" : `${status === "online" ? "更新于" : "上次数据"} ${age < 60 ? `${age}秒前` : duration(age) + "前"}`}
      {host.received_at !== null && <time dateTime={new Date(host.received_at * 1000).toISOString()}>{new Date(host.received_at * 1000).toLocaleTimeString("zh-CN", { hour12: false })}</time>}
    </footer>
  </article>;
}

export function ServersPage({ active }: { active: boolean }) {
  const [view, setView] = useState(() => window.location.hash === "#servers-mcp" ? "mcp" : "monitor");
  useEffect(() => {
    const restore = () => setView(window.location.hash === "#servers-mcp" ? "mcp" : "monitor");
    window.addEventListener("hashchange", restore); window.addEventListener("popstate", restore);
    return () => { window.removeEventListener("hashchange", restore); window.removeEventListener("popstate", restore); };
  }, []);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState<ProcessFilter>("work");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const state = useServerMonitor(active && view === "monitor", paused);
  const hosts = state.response?.hosts ?? [];
  const host = hosts.find(item => item.alias === selected) ?? hosts[0];
  const processes = filterProcesses(host?.data?.processes ?? [], filter, query);
  const stale = host && hostStatus(host, state.elapsed, !!state.error) !== "online";
  return <section id="server-monitor-page" className="servers-page kw-page" hidden={!active} aria-label="服务器">
    <header className="kw-page-heading"><div><h1 className="kw-page-title">服务器</h1><p className="servers-caption">{view === "mcp" ? "本机工作区 · 供网页 ChatGPT 使用" : paused ? "已暂停刷新" : "资源与进程 · 每 3 秒更新"}</p></div>
      {view === "monitor" && <div className="servers-actions"><button type="button" onClick={() => setPaused(value => !value)} aria-pressed={paused}>{paused ? <Play size={14}/> : <Pause size={14}/>} {paused ? "继续" : "暂停"}</button>
        <button type="button" onClick={state.reload} disabled={state.loading || paused} aria-label="刷新服务器状态"><RefreshCw size={14}/></button></div>}</header>
    <div className="server-page-tabs" role="tablist" aria-label="服务器页面"><button type="button" role="tab" aria-selected={view === "monitor"} onClick={() => { setView("monitor"); window.location.hash = "servers"; }}>服务器监控</button><button type="button" role="tab" aria-selected={view === "mcp"} onClick={() => { setView("mcp"); window.location.hash = "servers-mcp"; }}>MCP 服务</button></div>
    {view === "mcp" && <MCPServicesPanel active={active}/>}
    <div hidden={view !== "monitor"}>
    {state.error && <p className="servers-api-error" role="alert">{state.error} {hosts.some(item => item.data) && "当前保留上次数据。"}</p>}
    {state.response && !state.response.enabled ? <div className="servers-empty"><Server size={32}/><h2>还没有接入服务器</h2><p>在本机配置中启用服务器监控，添加已有的 SSH 主机别名后重启 KinaWatch。</p></div> : <>
      {!hosts.length ? <div className="servers-empty" role="status"><Server size={32}/><p>{state.error ? "监控暂时不可用" : "正在读取服务器…"}</p></div> : <>
        <div className="server-cards">{hosts.map(item => <HostCard key={item.alias} host={item} elapsed={state.elapsed} failed={!!state.error}/>)}</div>
        <section className="server-processes" aria-label="服务器进程">
          <div className="server-process-heading"><h2>进程</h2><div className="server-host-tabs" role="group" aria-label="选择进程所在服务器">{hosts.map(item => <button type="button" key={item.alias} aria-pressed={host?.alias === item.alias} onClick={() => { setSelected(item.alias); setLimit(50); }}>{item.alias}</button>)}</div></div>
          <div className="server-process-tools"><div className="server-process-filters" role="group" aria-label="进程筛选">{([['work', '训练 / 任务'], ['gpu', 'GPU 进程'], ['all', '全部 Python / 服务']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setLimit(50); }}>{label}</button>)}</div>
            <label className="server-search"><Search size={14}/><input aria-label="搜索进程" placeholder="任务、用户或 PID" value={query} onChange={event => { setQuery(event.target.value); setLimit(50); }}/></label></div>
          {stale && host?.data && <p className="server-stale-note">这是上次收到的进程列表，当前运行情况尚未确认。</p>}
          {processes.length ? <div className="server-table-scroll" tabIndex={0} role="region" aria-label="进程表，可横向滚动"><table className="server-table"><thead><tr><th scope="col">任务 / 命令</th><th scope="col">用户</th><th scope="col">PID</th><th scope="col">CPU</th><th scope="col">内存</th><th scope="col">显存</th></tr></thead>
            <tbody>{processes.slice(0, limit).map(item => <tr key={`${host.alias}:${item.pid}:${item.start}`}><td><details><summary title={item.task}>{item.task}</summary><div className="server-command"><p>运行 {duration(item.age)}</p><pre>{item.command || "无法读取启动命令"}</pre></div></details></td><td>{item.owner}</td><td>{item.pid}</td><td>{metric(item.cpu)}{item.cpu !== null && "%"}</td><td>{bytes(item.rss)}</td><td>{item.gpu_mib ? gpuMemory(item.gpu_mib) : "—"}</td></tr>)}</tbody>
          </table></div> : <p className="server-process-empty">{!host?.data ? "收到服务器数据后显示进程。" : "当前筛选下没有进程。"}</p>}
          <div className="server-process-footer"><span>{processes.length} 个进程 · 进程 CPU 的 100% 表示一个逻辑核</span>{processes.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)}>再显示 50 条</button>}</div>
        </section>
      </>}
    </>}
    </div>
  </section>;
}
