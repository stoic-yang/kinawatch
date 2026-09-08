// Stable colors per KinaWatch category id, tuned to similar luminance so no
// single category screams. Unknown categories fall back to a hash-picked
// pool color so new upstream categories stay visible.
const CATEGORY_COLORS: Record<string, string> = {
  ai_collaboration: "#5B7CE6",
  coding: "#7A5AF8",
  research: "#1FA97C",
  coursework: "#3AA0D8",
  technical_learning: "#57B26A",
  writing: "#E0A63A",
  document_work: "#C08A4E",
  reading: "#E07B4F",
  planning: "#9B7DE0",
  communication: "#E06C8A",
  social: "#C562A8",
  browsing: "#EE9A3C",
  entertainment: "#E25F5F",
  video: "#B27C9B",
  life: "#8F9870",
  system: "#9AA3B2",
  remote: "#4FB39A",
  uncategorized: "#D4D4D2",
};

const POOL = [
  "#5B7CE6",
  "#1FA97C",
  "#EE9A3C",
  "#9B7DE0",
  "#E06C8A",
  "#3AA0D8",
  "#E0A63A",
  "#4FB39A",
];

export function categoryColor(category: string): string {
  const known = CATEGORY_COLORS[category];
  if (known) return known;
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return POOL[h % POOL.length];
}
