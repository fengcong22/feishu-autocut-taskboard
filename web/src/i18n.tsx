import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { BoardStageLabels, TaskPriority, TaskStatus } from "./types";

export type TaskboardLanguage = "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-CN" | "en";
  text: (chinese: string, english: string) => string;
  statusLabel: (status: TaskStatus) => string;
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
    statusLabel: (status) => STATUS_LABELS.zh[status],
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
    statusLabel: (status) => STATUS_LABELS.en[status],
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  zh: {
    backlog: "待立项",
    todo: "待处理",
    queued: "排队中",
    in_progress: "处理中",
    in_review: "待验收",
    blocked: "遇到阻碍",
    done: "已完成",
    canceled: "已取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    queued: "Queued",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  zh: {
    none: "无优先级",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

interface TaskboardLanguageContextValue {
  language: TaskboardLanguage;
  stageLabels: BoardStageLabels | null;
}

const TaskboardLanguageContext = createContext<TaskboardLanguageContextValue>({
  language: "en",
  stageLabels: null,
});

export function resolveTaskboardLanguage(value: string | null | undefined): TaskboardLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

export function getTaskboardI18n(
  language: TaskboardLanguage,
  stageLabels: BoardStageLabels | null = null,
): TaskboardI18n {
  const base = I18N[language];
  return stageLabels
    ? {
      ...base,
      statusLabel: (status) => stageLabels.labels[language][status] ?? base.statusLabel(status),
    }
    : base;
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return STATUS_LABELS[language][status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return PRIORITY_LABELS[language][priority];
}

export function TaskboardLanguageProvider({
  language,
  stageLabels = null,
  children,
}: {
  language: TaskboardLanguage;
  stageLabels?: BoardStageLabels | null;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={{ language, stageLabels }}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  const { language, stageLabels } = useContext(TaskboardLanguageContext);
  return useMemo(
    () => getTaskboardI18n(language, stageLabels),
    [language, stageLabels],
  );
}
