import { useEffect, useRef, useState } from "react";
import type { ServerResponse } from "./serverMonitor";

export function useServerMonitor(active: boolean, paused: boolean) {
  const [response, setResponse] = useState<ServerResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const received = useRef(performance.now());
  useEffect(() => {
    if (!active) return;
    let closed = false;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The shared rhythm view can temporarily hide this page without unmounting it.
    const visible = () => document.visibilityState === "visible" && !!document.getElementById("server-monitor-page")?.getClientRects().length;
    async function poll() {
      clearTimeout(timer);
      if (closed) return;
      if (!visible() || paused) { timer = setTimeout(poll, 3000); return; }
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      setLoading(true);
      try {
        const result = await fetch("/api/servers", { signal: controller.signal, cache: "no-store" });
        if (!result.ok) throw new Error("服务器监控暂时无法读取，请检查本机配置后重试。");
        const data = await result.json() as ServerResponse;
        if (!closed && !controller.signal.aborted) {
          received.current = performance.now();
          setResponse(data); setNow(received.current); setError("");
        }
      } catch (reason) {
        if (!closed && visible()) setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "本机监控服务未响应，正在重试。");
      } finally {
        clearTimeout(timeout); pending = null;
        if (!closed) { setLoading(false); timer = setTimeout(poll, 3000); }
      }
    }
    const visibility = () => {
      if (!visible()) { pending?.abort(); clearTimeout(timer); }
      else if (!pending) void poll();
    };
    const clock = setInterval(() => { if (visible()) setNow(performance.now()); }, 1000);
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { closed = true; clearTimeout(timer); clearInterval(clock); pending?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [active, paused, revision]);
  return { response, error, loading, elapsed: Math.max(0, (now - received.current) / 1000), reload: () => setRevision(value => value + 1) };
}
