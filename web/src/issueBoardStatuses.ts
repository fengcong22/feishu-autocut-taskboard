import type { TaskStatus } from "./types";

export const MAIN_STATUSES = [
  "todo",
  "queued",
  "in_progress",
  "blocked",
  "in_review",
] as const satisfies readonly TaskStatus[];

export const SECONDARY_STATUSES = [
  "backlog",
  "done",
  "canceled",
] as const satisfies readonly TaskStatus[];

export const OTHER_TASK_TABS = [
  ...SECONDARY_STATUSES,
  "archived",
] as const;

export type MainTaskStatus = (typeof MAIN_STATUSES)[number];
export type SecondaryTaskStatus = (typeof SECONDARY_STATUSES)[number];
export type OtherTaskTab = (typeof OTHER_TASK_TABS)[number];
export type OtherTasksPanelTab = OtherTaskTab | "ordinary";
