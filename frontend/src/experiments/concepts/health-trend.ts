export function healthTrend(values: (number | null)[], baseMaximum: number) {
  const step = baseMaximum / 5;
  const maximum = Math.max(baseMaximum, ...values.map(value => Math.ceil((value ?? 0) / step) * step));
  const points = values.map((value, index) => ({
    x: (index + .5) / values.length * 100,
    y: value === null ? null : 100 - value / maximum * 100,
  }));
  const paths: string[] = [];
  let segment: string[] = [];
  function finish() {
    if (segment.length > 1) paths.push(`M ${segment.join(" L ")}`);
    segment = [];
  }
  for (const point of points) {
    if (point.y === null) finish();
    else segment.push(`${point.x.toFixed(3)},${point.y.toFixed(3)}`);
  }
  finish();
  return { maximum, points, paths };
}
