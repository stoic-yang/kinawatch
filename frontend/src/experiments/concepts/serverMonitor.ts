export type Metric = number | null;
export interface ServerProcess {
  pid: Metric; owner: string; task: string; command: string; service: boolean;
  cpu: Metric; rss: Metric; gpu_mib: Metric; age: Metric; start: Metric;
}
export interface ServerData {
  cpu_scope?: "host" | "cgroup"; memory_scope?: "host" | "cgroup";
  hostname: string; time: number; cpu: Metric; cores: Metric; uptime: Metric; load: string[]; errors: string[];
  memory: { total: Metric; used: Metric; available: Metric }; swap: { total: Metric; used: Metric };
  disks: { path: string; total: Metric; used: Metric; free: Metric; percent: Metric }[];
  gpus: { index: string; name: string; util: Metric; used_mib: Metric; total_mib: Metric; temperature: Metric; power: Metric }[];
  processes: ServerProcess[];
}
export interface ServerHost {
  alias: string; route: string; status: "online" | "offline" | "stale" | "connecting";
  age_seconds: number | null; received_at: number | null; error: string; samples: number; data: ServerData | null;
}
export interface ServerResponse { enabled: boolean; poll_seconds: number; stale_seconds: number; hosts: ServerHost[] }
export type ProcessFilter = "work" | "gpu" | "all";

export function hostStatus(host: ServerHost, elapsed: number, failed = false): ServerHost["status"] {
  if (failed) return host.data ? "stale" : "offline";
  if (host.status === "online" && (host.age_seconds === null || host.age_seconds + elapsed > 10)) return "stale";
  return host.status;
}
export function percent(used: Metric, total: Metric): Metric {
  return used === null || total === null || total <= 0 ? null : used / total * 100;
}
export function metric(value: Metric, digits = 1) { return value === null ? "—" : value.toFixed(digits); }
export function bytes(value: Metric) {
  if (value === null) return "—";
  return value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(0)} MiB` : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
export function gpuMemory(value: Metric) { return bytes(value === null ? null : value * 1024 ** 2); }
export function duration(value: Metric) {
  if (value === null) return "—";
  if (value >= 86400) return `${Math.floor(value / 86400)}天 ${Math.floor(value % 86400 / 3600)}时`;
  if (value >= 3600) return `${Math.floor(value / 3600)}时 ${Math.floor(value % 3600 / 60)}分`;
  return `${Math.floor(value / 60)}分`;
}
export function filterProcesses(items: ServerProcess[], filter: ProcessFilter, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (filter === "all" || (item.gpu_mib ?? 0) > 0 || (filter === "work" && !item.service))
    && (!needle || `${item.owner} ${item.pid} ${item.task} ${item.command}`.toLocaleLowerCase().includes(needle)));
}
