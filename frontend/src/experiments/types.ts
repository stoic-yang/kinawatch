import type { ReactNode } from "react";
import type { DayMode, DayResponse, FileFingerprint, RangeDay, ScreenTimelineBlock, WorkflowSaveResponse } from "../api";
import type { ScreenSession } from "../lib/sessions";

export type ThemeId = "paper" | "orbit" | "grove" | "studio" | "tide";

/** Presentation-only slots. All data, editing and date state stay in App. */
export interface ThemeShellProps {
  date: string;
  currentDate: string;
  dateLabel: string;
  weekday: string;
  year: number;
  weekNumber: number;
  day: DayResponse | null;
  displayDay: DayResponse | null;
  sessions: ScreenSession[];
  timezone: string;
  dayMode: DayMode;
  dayStartClock: string;
  onInspect: (block: ScreenTimelineBlock) => void;
  journalWriteEnabled: boolean;
  onDaySaved: (savedWorkflow?: WorkflowSaveResponse, editedFingerprint?: FileFingerprint) => Promise<void>;
  days: RangeDay[];
  screenTime: string;
  passiveTime: string;
  windowLabel: string;
  sessionCount: number;
  topApp: string;
  selectDate: (date: string) => void;
  calendar: ReactNode;
  timeline: ReactNode;
  rhythm: ReactNode;
  workflow: ReactNode;
  notes: ReactNode;
  warnings: ReactNode;
  overlay: ReactNode;
  status: ReactNode;
}

export const THEMES: { id: ThemeId; name: string; english: string; port: number }[] = [
  { id: "paper", name: "纸间", english: "Paper", port: 8811 },
  { id: "orbit", name: "轨道", english: "Orbit", port: 8812 },
  { id: "grove", name: "林间", english: "Grove", port: 8813 },
  { id: "studio", name: "构造", english: "Studio", port: 8814 },
  { id: "tide", name: "潮汐", english: "Tide", port: 8815 },
];
