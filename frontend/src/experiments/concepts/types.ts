import type { ThemeShellProps } from "../types";

export type ConceptProps = ThemeShellProps;
export type ConceptId = "journal" | "daymap" | "workbench" | "atlas" | "chapters";
export const CONCEPTS: {id: ConceptId; name: string; english: string; port: number; subtitle: string}[] = [
  {id: "journal", name: "书房", english: "Journal", port: 8821, subtitle: "从书写开始"},
  {id: "daymap", name: "日程画布", english: "Daymap", port: 8822, subtitle: "沿时间展开"},
  {id: "workbench", name: "活动工作台", english: "Workbench", port: 8823, subtitle: "按主题组织"},
  {id: "atlas", name: "周间", english: "Atlas", port: 8824, subtitle: "从一周看一天"},
  {id: "chapters", name: "章节", english: "Chapters", port: 8825, subtitle: "把一天读成故事"},
];
