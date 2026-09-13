import { useEffect, useState } from "react";
import type { TimetableResponse } from "./timetable";

export function useTimetable(active: boolean) {
  const [data, setData] = useState<TimetableResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const tick = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    const refresh = () => { if (document.visibilityState === "visible") { tick(); setAttempt(value => value + 1); } };
    tick();
    const timer = window.setInterval(tick, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/timetable", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("课表暂时无法读取，请重试。");
        return await response.json() as TimetableResponse;
      })
      .then(value => { if (!controller.signal.aborted) { setData(value); setError(value.error); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "课表暂时无法读取。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, attempt]);
  return { table: data?.snapshot ?? null, error, loading, now, reload: () => setAttempt(value => value + 1) };
}
export type TimetableState = ReturnType<typeof useTimetable>;
