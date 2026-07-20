import type { DayResponse } from "../api";
import { fmtDuration } from "../lib/format";

// Routine source/cache metadata is intentionally not shown. Only actionable
// data problems remain visible, and the component disappears when there are
// no warnings.
export function QualityWarnings({ day }: { day: DayResponse }) {
  const q = day.quality;
  const warnings: string[] = [
    ...q.issues,
    ...q.parse_warnings.map((w) => `日记解析：${w.message}`),
    ...q.overlap_warnings.map(
      (w) => `屏幕/离线重叠 ${fmtDuration(w.overlap_seconds)}：${w.message}`,
    ),
  ];

  if (warnings.length === 0) return null;

  return (
    <aside className="quality-warnings" aria-label="数据警告">
      <ul>
        {warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </aside>
  );
}
