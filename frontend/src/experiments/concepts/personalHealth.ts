import { useEffect, useRef, useState } from "react";

export interface SleepRecord {
  minutes: number; main_minutes: number; start: string; end: string;
  basis: "in_bed" | "asleep"; source: string;
  sessions: { start: string; end: string; minutes: number }[];
}
export interface HealthDay {
  date: string; sleep: SleepRecord | null;
  steps: { count: number; method: "daily_source_max"; sources: Record<string, number> } | null;
}
export interface HealthSnapshot {
  version: number; revision: string; available: boolean; timezone: string;
  exported_at?: string; imported_at?: string;
  record_counts?: { sleep: number; steps: number; skipped: number };
  sync?: { enabled: boolean; state: "waiting" | "ready" | "error"; exported_at?: string; error?: string };
  days: HealthDay[];
}

export function shiftHealthDate(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
export function healthWindow(snapshot: HealthSnapshot | null, end: string, count: number): HealthDay[] {
  const lookup = new Map(snapshot?.days.map(day => [day.date, day]));
  return Array.from({ length: count }, (_, i) => {
    const date = shiftHealthDate(end, i + 1 - count);
    return lookup.get(date) ?? { date, sleep: null, steps: null };
  });
}
export function meanSleep(days: HealthDay[]): number | null {
  const recorded = days.filter(day => day.sleep !== null);
  return recorded.length ? recorded.reduce((sum, day) => sum + day.sleep!.minutes, 0) / recorded.length : null;
}
export function sleepDuration(minutes: number | null | undefined): string {
  if (minutes == null) return "未记录";
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)} 小时 ${rounded % 60} 分`;
}
export const healthClock = (time: string) => time.slice(11, 16);
export function nightPosition(time: string): number {
  const hours = Number(time.slice(11, 13)) + Number(time.slice(14, 16)) / 60;
  return ((hours - 18 + 24) % 24) / 24 * 100;
}

async function readResponse(response: Response): Promise<HealthSnapshot> {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "健康数据暂时无法读取。");
  return result;
}

export function usePersonalHealth(active: boolean) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    if (!active) return;
    const refresh = () => { if (document.visibilityState === "visible" && !busy.current) setAttempt(value => value + 1); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active]);
  useEffect(() => {
    if (!active || busy.current) return;
    const ticket = ++sequence.current;
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/personal-health", { signal: controller.signal, cache: "no-store" })
      .then(readResponse).then(data => { if (ticket === sequence.current) { setSnapshot(data); setError(null); } })
      .catch(reason => { if (!controller.signal.aborted && ticket === sequence.current) setError(String(reason.message || reason)); })
      .finally(() => { if (ticket === sequence.current) setLoading(false); });
    return () => controller.abort();
  }, [active, attempt]);
  async function importFile(file: File) {
    if (busy.current || !snapshot) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > 64 * 1024 * 1024) {
      setError("请选择不超过 64 MB 的 Apple 健康导出 ZIP。"); return;
    }
    busy.current = true; ++sequence.current;
    setImporting(true); setLoading(false); setError(null);
    try {
      const response = await fetch("/api/personal-health/import", {
        method: "POST", headers: { "Content-Type": "application/zip", "If-Match": snapshot.revision }, body: file,
      });
      setSnapshot(await readResponse(response));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setImporting(false); }
  }
  return { snapshot, error, loading, importing, importFile, reload: () => setAttempt(value => value + 1) };
}
export type PersonalHealthState = ReturnType<typeof usePersonalHealth>;
