/** Semantic colors for the Journal shell, including overlays outside the shell. */
export const PALETTES = [
  { id: "graphite", name: "石墨", description: "中性灰 · 清爽克制", dark: false, colors: {
    canvas: "#ffffff", surface: "#ffffff", "surface-subtle": "#fafafb", rail: "#f5f5f7",
    control: "#f1f2f4", "control-hover": "#e9ebef", "control-active": "#eaf0fc",
    line: "#e7e8ec", "line-strong": "#c9ccd3", ink: "#202126", muted: "#656973", faint: "#858a94",
    accent: "#3568d4", "accent-strong": "#2454bb", "on-accent": "#ffffff",
    "heat-0": "#edf0f4", "heat-1": "#cbd5e1", "heat-2": "#9caec3", "heat-3": "#7188a4", "heat-4": "#455f7e",
  } },
  { id: "porcelain", name: "素白", description: "纯白与黑 · 留白清晰", dark: false, colors: {
    canvas: "#f7f7f7", surface: "#ffffff", "surface-subtle": "#fafafa", rail: "#f0f0f0",
    control: "#f3f3f3", "control-hover": "#e8e8e8", "control-active": "#e2e2e2",
    line: "#e5e5e5", "line-strong": "#c6c6c6", ink: "#242424", muted: "#626262", faint: "#717171",
    accent: "#454545", "accent-strong": "#202020", "on-accent": "#ffffff",
    "heat-0": "#f0f0f0", "heat-1": "#d4d4d4", "heat-2": "#a4a4a4", "heat-3": "#747474", "heat-4": "#3f3f3f",
  } },
  { id: "cobalt", name: "钴蓝", description: "中性白 · 一点明亮的蓝", dark: false, colors: {
    canvas: "#f5f6f8", surface: "#ffffff", "surface-subtle": "#f8f9fb", rail: "#eceef3",
    control: "#f0f2f7", "control-hover": "#e5e9f3", "control-active": "#dfe6fa",
    line: "#dfe3eb", "line-strong": "#bec9df", ink: "#222b3b", muted: "#5b677c", faint: "#667188",
    accent: "#345ac9", "accent-strong": "#2447ad", "on-accent": "#ffffff",
    "heat-0": "#edf0f7", "heat-1": "#ced9f4", "heat-2": "#9db2e9", "heat-3": "#6a88d8", "heat-4": "#3b5ec1",
  } },
  { id: "clay", name: "陶土", description: "暖白底色 · 陶红点缀", dark: false, colors: {
    canvas: "#f6f4f2", surface: "#fffefd", "surface-subtle": "#faf8f6", rail: "#eeeae6",
    control: "#f2eeeb", "control-hover": "#e9e1db", "control-active": "#eddcd5",
    line: "#e4ddd7", "line-strong": "#cdbbb0", ink: "#352d29", muted: "#6d5d54", faint: "#79665c",
    accent: "#974733", "accent-strong": "#813b2b", "on-accent": "#ffffff",
    "heat-0": "#f0eae6", "heat-1": "#e4c9bd", "heat-2": "#cc9b85", "heat-3": "#b7765d", "heat-4": "#944b36",
  } },
  { id: "charcoal", name: "曜石", description: "炭灰与银 · 安静的深色", dark: true, colors: {
    canvas: "#18191b", surface: "#222326", "surface-subtle": "#28292c", rail: "#1d1e20",
    control: "#2d2f33", "control-hover": "#383b40", "control-active": "#41454b",
    line: "#36383d", "line-strong": "#575b62", ink: "#eeeeef", muted: "#b4b6bc", faint: "#a3a7ae",
    accent: "#c6ccd6", "accent-strong": "#edf0f5", "on-accent": "#202226",
    "heat-0": "#2a2c30", "heat-1": "#474c55", "heat-2": "#6c7583", "heat-3": "#99a4b5", "heat-4": "#c9d2df",
  } },
] as const;

export type PaletteId = typeof PALETTES[number]["id"];
const STORAGE_KEY = "kinawatch.appearance.palette";
const LEGACY_PALETTES: Record<string, PaletteId> = { sea: "cobalt", sand: "clay", iris: "porcelain", night: "charcoal" };
function resolvePalette(id: string | null) {
  return PALETTES.find(palette => palette.id === id)?.id ?? LEGACY_PALETTES[id ?? ""];
}
export function currentPalette(): PaletteId {
  return PALETTES.find(palette => palette.id === document.documentElement.dataset.palette)?.id ?? "graphite";
}

export function applyPalette(id: PaletteId, persist = false) {
  const palette = PALETTES.find(item => item.id === id)!;
  const root = document.documentElement;
  root.dataset.palette = palette.id;
  root.style.colorScheme = palette.dark ? "dark" : "light";
  for (const [name, color] of Object.entries(palette.colors)) root.style.setProperty(`--kw-palette-${name}`, color);
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
  applyPalette(resolvePalette(requested) ?? resolvePalette(saved) ?? "graphite");
}
