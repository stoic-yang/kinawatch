import { DailyTrend } from "../../components/DailyTrend";
import { sleepDuration, type HealthDay } from "./personalHealth";

const numbers = new Intl.NumberFormat("zh-CN");
const sleepTick = (value: number) => `${value / 60}小时`;
const stepsValue = (value: number) => `${numbers.format(value)} 步`;
const count = (value: number) => numbers.format(value);

export function HealthTrend({ days, selected, kind, visible, onSelect }: {
  days: HealthDay[]; selected: string; kind: "sleep" | "steps"; visible: boolean; onSelect: (date: string) => void;
}) {
  const sleep = kind === "sleep";
  return <DailyTrend days={days.map(day => ({ date: day.date, value: sleep ? day.sleep?.minutes ?? null : day.steps?.count ?? null }))}
    selected={selected} visible={visible} label={sleep ? "睡眠时长" : "步数"} baseMaximum={sleep ? 600 : 5000}
    formatValue={sleep ? sleepDuration : stepsValue} formatTick={sleep ? sleepTick : count} formatMarker={sleep ? sleepDuration : count}
    onSelect={onSelect}/>;
}
