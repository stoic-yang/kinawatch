/** Complete semantic palettes shared by pages, charts, and top-layer content. */
type PaletteColors = Record<
  "canvas" | "surface" | "surface-subtle" | "rail" | "control" | "control-hover" |
  "control-active" | "line" | "line-strong" | "ink" | "muted" | "faint" |
  "accent" | "accent-strong" | "on-accent" | "chart" |
  "heat-0" | "heat-1" | "heat-2" | "heat-3" | "heat-4", string>;

export const PALETTES = [
  { id: "moon", name: "月白", description: "月白 · 墨蓝", dark: false, colors: {
    canvas: "#fafbfc", surface: "#ffffff", "surface-subtle": "#eef2f6", rail: "#263648",
    control: "#eef2f6", "control-hover": "#eef3f7", "control-active": "#dce6f0",
    line: "#d9e1e8", "line-strong": "#b9c6d2", ink: "#293442", muted: "#657383", faint: "#657383",
    accent: "#496783", "accent-strong": "#354b62", "on-accent": "#ffffff", chart: "#9db2c6",
    "heat-0": "#eef2f6", "heat-1": "#d6e1eb", "heat-2": "#adc1d3", "heat-3": "#7a99b4", "heat-4": "#496783",
  } },
  { id: "mist", name: "雾白", description: "雾白 · 松灰", dark: false, colors: {
    canvas: "#f8faf8", surface: "#ffffff", "surface-subtle": "#edf2ee", rail: "#dce5e0",
    control: "#edf2ee", "control-hover": "#edf3ef", "control-active": "#dce7df",
    line: "#d6e0d9", "line-strong": "#b6c8bd", ink: "#303c37", muted: "#647469", faint: "#647469",
    accent: "#466d57", "accent-strong": "#344f40", "on-accent": "#ffffff", chart: "#9fb9a9",
    "heat-0": "#edf2ee", "heat-1": "#d3e1d8", "heat-2": "#aec9b8", "heat-3": "#7da38c", "heat-4": "#466d57",
  } },
  { id: "frost", name: "霜白", description: "霜白 · 紫灰", dark: false, colors: {
    canvas: "#fafafc", surface: "#ffffff", "surface-subtle": "#f1eff5", rail: "#36323f",
    control: "#f1eff5", "control-hover": "#f1eff5", "control-active": "#e6e0ed",
    line: "#dfdae7", "line-strong": "#c4bacf", ink: "#3b3845", muted: "#776e80", faint: "#776e80",
    accent: "#74658a", "accent-strong": "#574869", "on-accent": "#ffffff", chart: "#b5a8c7",
    "heat-0": "#f1eff5", "heat-1": "#e0d8e9", "heat-2": "#c4b6d4", "heat-3": "#9d8ab3", "heat-4": "#74658a",
  } },
  { id: "graphite", name: "石墨", description: "浅灰 · 清蓝", dark: false, colors: {
    canvas: "#ffffff", surface: "#ffffff", "surface-subtle": "#fafafb", rail: "#f5f5f7",
    control: "#f1f2f4", "control-hover": "#e9ebef", "control-active": "#eaf0fc",
    line: "#e7e8ec", "line-strong": "#c9ccd3", ink: "#202126", muted: "#606570", faint: "#686e79",
    accent: "#3568d4", "accent-strong": "#2454bb", "on-accent": "#ffffff", chart: "#a9bde8",
    "heat-0": "#edf0f4", "heat-1": "#cbd5e1", "heat-2": "#9caec3", "heat-3": "#7188a4", "heat-4": "#455f7e",
  } },
  { id: "parchment", name: "沙纸", description: "暖纸 · 茶褐", dark: false, colors: {
    canvas: "#f8f5ee", surface: "#fffdf8", "surface-subtle": "#f5f1e8", rail: "#eee8dd",
    control: "#f0eadf", "control-hover": "#e8dfd0", "control-active": "#eadcc3",
    line: "#e6dfd2", "line-strong": "#c9bdab", ink: "#352f27", muted: "#6e6456", faint: "#706454",
    accent: "#89632e", "accent-strong": "#704e22", "on-accent": "#fffdf8", chart: "#c9ae7d",
    "heat-0": "#f0e9dc", "heat-1": "#e1cfa9", "heat-2": "#c9ac76", "heat-3": "#ab864e", "heat-4": "#82602e",
  } },
  { id: "pine", name: "松青", description: "雾白 · 松绿", dark: false, colors: {
    canvas: "#f3f7f4", surface: "#fcfefc", "surface-subtle": "#eff5f1", rail: "#e5eee8",
    control: "#eaf2ed", "control-hover": "#dceae1", "control-active": "#d5e8de",
    line: "#dce6df", "line-strong": "#b5cbbd", ink: "#253c32", muted: "#576e61", faint: "#596d60",
    accent: "#326e56", "accent-strong": "#24533f", "on-accent": "#ffffff", chart: "#93bba6",
    "heat-0": "#e8f0eb", "heat-1": "#c3dccd", "heat-2": "#92bda5", "heat-3": "#60977a", "heat-4": "#346e52",
  } },
  { id: "indigo", name: "暮蓝", description: "云灰 · 靛蓝", dark: false, colors: {
    canvas: "#f5f5fa", surface: "#fefeff", "surface-subtle": "#f2f2f8", rail: "#eaeaf3",
    control: "#ededf6", "control-hover": "#e2e2f0", "control-active": "#dfdff2",
    line: "#e1e1ec", "line-strong": "#c1c1d8", ink: "#2c2d42", muted: "#62637c", faint: "#65667c",
    accent: "#605da8", "accent-strong": "#494684", "on-accent": "#ffffff", chart: "#aaa8d4",
    "heat-0": "#ececf4", "heat-1": "#d3d1e8", "heat-2": "#b0add2", "heat-3": "#8883b9", "heat-4": "#5f599b",
  } },
  { id: "midnight", name: "夜航", description: "深海 · 青灰", dark: true, colors: {
    canvas: "#121a23", surface: "#19232e", "surface-subtle": "#1d2935", rail: "#101820",
    control: "#253340", "control-hover": "#304353", "control-active": "#334b59",
    line: "#2e3d4b", "line-strong": "#506574", ink: "#e4edf2", muted: "#a9bac7", faint: "#93a8b7",
    accent: "#96c6cf", "accent-strong": "#bde0e6", "on-accent": "#14242c", chart: "#507e91",
    "heat-0": "#243440", "heat-1": "#344f60", "heat-2": "#507b8c", "heat-3": "#73a7b4", "heat-4": "#a5d2d9",
  } },
] as const satisfies ReadonlyArray<{id: string; name: string; description: string; dark: boolean; colors: PaletteColors}>;

export type PaletteId = typeof PALETTES[number]["id"];
const STORAGE_KEY = "kinawatch.appearance.palette";
const LEGACY_PALETTES: Record<string, PaletteId> = {
  porcelain: "parchment", cobalt: "indigo", clay: "parchment", charcoal: "midnight",
  sea: "pine", sand: "parchment", iris: "indigo", night: "midnight",
};
function resolvePalette(id: string | null) {
  return PALETTES.find(palette => palette.id === id)?.id ?? LEGACY_PALETTES[id ?? ""];
}
export function currentPalette(): PaletteId {
  return PALETTES.find(palette => palette.id === document.documentElement.dataset.palette)?.id ?? "moon";
}

export function applyPalette(id: PaletteId, persist = false) {
  const palette = PALETTES.find(item => item.id === id)!;
  const root = document.documentElement;
  root.dataset.palette = palette.id;
  root.style.colorScheme = palette.dark ? "dark" : "light";
  for (const [name, color] of Object.entries(palette.colors)) root.style.setProperty(`--kw-palette-${name}`, color);
  const rail = id === "moon" ? ["#f1f5f9", "#afbecc", "#354b62"] : id === "frost" ? ["#f0edf4", "#c1b8ca", "#4c445b"] : id === "mist" ? ["#34483c", "#4e6255", "#c8d8ce"] : [palette.colors.ink, palette.colors.muted, palette.colors["control-active"]];
  ["ink", "muted", "active"].forEach((name, index) => root.style.setProperty(`--kw-palette-rail-${name}`, rail[index]));
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* Browsing without storage still supports switching. */ }
    const url = new URL(window.location.href);
    url.searchParams.set("palette", id);
    window.history.replaceState(window.history.state, "", url);
  }
}

export function initializePalette() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Storage can be unavailable. */ }
  const requested = new URLSearchParams(window.location.search).get("palette");
  applyPalette(resolvePalette(requested) ?? resolvePalette(saved) ?? "moon");
}
