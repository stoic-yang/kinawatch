export interface MCPService {
  id: string; name: string; workspace: string; port?: number;
  status: "starting" | "stopping" | "running" | "stopped" | "error";
  busy: boolean; url: string | null; error: string; legacy: boolean;
  local_ready?: boolean; server_running?: boolean; tunnel_running?: boolean; verified_at?: number | null;
}
export interface MCPServicesResponse {
  enabled: boolean; runtime: { ready: boolean; error: string; version?: string }; services: MCPService[];
}
export interface FolderListing {
  path: string; parent: string | null; selectable: boolean; reason: string; truncated: boolean;
  roots: { name: string; path: string }[]; folders: { name: string; path: string }[];
}
export async function mcpRequest<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api/mcp/${path}`, {
    method: payload === undefined ? "GET" : "POST", signal, cache: "no-store",
    headers: payload === undefined ? undefined : { "Content-Type": "application/json", "X-KinaWatch-MCP": "1" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || "MCP 服务暂时无法读取");
  return data as T;
}
export function canStart(service: MCPService) { return !service.busy && service.status !== "running"; }
export function canStop(service: MCPService) { return !service.busy && (service.server_running || service.tunnel_running || service.status === "running"); }
export function connectionUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname)
      && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash ? value : null;
  } catch { return null; }
}
