import type { RangeDay, RhythmDevice } from "../../api";

const deviceKeys = new Set(["mac", "ipad", "iphone", "other", "offline"]);
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function rhythmDevices(day: RangeDay): RhythmDevice[] | null {
  const devices = day.rhythm?.devices;
  const total = day.overview?.combined_nonoverlap_seconds;
  if (!Array.isArray(devices) || !seconds(total)) return null;
  if (!devices.every(device => device && deviceKeys.has(device.device) && typeof device.label === "string"
    && seconds(device.active_seconds) && (device.observed_seconds === null || seconds(device.observed_seconds)))) return null;
  if (new Set(devices.map(device => device.device)).size !== devices.length) return null;
  const sum = devices.reduce((value, device) => value + device.active_seconds, 0);
  // Older or inconsistent payloads must not invent a device split.
  return Math.abs(sum - total) <= Math.max(.05, total * 1e-6) ? devices : null;
}
