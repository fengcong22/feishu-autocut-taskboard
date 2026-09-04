import {
  disableFeishuSubject,
  enableFeishuSubject,
  exportFeishuWorkflowShare,
  importFeishuWorkflowShare,
  listFeishuWorkflowCatalog,
  removeFeishuBase,
  removeFeishuSubject,
  saveFeishuSubjectDraft,
  setFeishuSubjectDisplayEnabled,
  upsertFeishuBasePreview,
} from "./api";
import type {
  FeishuBaseCatalog,
  FeishuSubjectConfig,
  FeishuWorkflowShareConfiguration,
  FeishuWorkflowShareResult,
} from "./types";

export { listFeishuWorkflowCatalog };
export { exportFeishuWorkflowShare, importFeishuWorkflowShare };
export { removeFeishuBase, removeFeishuSubject };

export function selectedFeishuSubject(
  catalog: FeishuBaseCatalog[],
  selectedSubjectKey: string | null,
): FeishuSubjectConfig | null {
  if (!selectedSubjectKey) return null;
  for (const base of catalog) {
    const subject = base.subjects.find((candidate) => candidate.subjectKey === selectedSubjectKey);
    if (subject) return subject;
  }
  return null;
}

export async function addFeishuBaseFromUrl(url: string): Promise<FeishuBaseCatalog> {
  // The local API accepts normalized preview objects. URL resolution is kept at the
  // server boundary so credentials and SDK details never enter the browser bundle.
  return upsertFeishuBasePreview({ url });
}

export async function saveFeishuWorkflowDraft(subjectKey: string, patch: unknown): Promise<FeishuSubjectConfig> {
  return saveFeishuSubjectDraft(subjectKey, patch);
}

export async function setFeishuSubjectEnabled(subject: FeishuSubjectConfig): Promise<FeishuSubjectConfig> {
  return enableFeishuSubject(subject.subjectKey, subject.configVersion);
}

export async function setFeishuSubjectDisabled(subject: FeishuSubjectConfig): Promise<FeishuSubjectConfig> {
  return disableFeishuSubject(subject.subjectKey, subject.configVersion);
}

export async function setFeishuSubjectDisplay(
  subject: FeishuSubjectConfig,
  displayEnabled: boolean,
): Promise<FeishuSubjectConfig> {
  return setFeishuSubjectDisplayEnabled(subject.subjectKey, displayEnabled);
}

export async function previewFeishuWorkflowShare(
  configuration: FeishuWorkflowShareConfiguration,
): Promise<FeishuWorkflowShareResult> {
  return importFeishuWorkflowShare(configuration, true);
}
