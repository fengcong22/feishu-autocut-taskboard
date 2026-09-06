import type { ChangeEvent } from "react";

export type FeishuStageId = "initial" | "first_review" | "final_review";
export type StageSourceKind = "docx_section" | "base_attachment";
export type StageAudioMode = "video_original" | "replace_original";

export interface StageFieldOption {
  id: string;
  name: string;
}

export interface StageMetadataField {
  fieldId: string;
  fieldName: string;
  type?: number | string | null;
  uiType?: string | null;
  options?: StageFieldOption[];
}

export interface StageSourceValue {
  kind: StageSourceKind;
  anchorText?: string;
  fieldId?: string;
}

export interface FeishuStageValue {
  enabled: boolean;
  trigger: {
    fieldId: string | null;
    fieldName?: string | null;
    optionId: string | null;
    value: string;
  };
  videoSource: StageSourceValue;
  reviewSource: StageSourceValue;
  audio: {
    mode: StageAudioMode;
    source?: StageSourceValue | null;
    durationToleranceSeconds?: number;
  };
  artifactTargetPath?: string | null;
  nameSuffix: string;
}

export interface FeishuStageEditorProps {
  stageId: FeishuStageId;
  value: FeishuStageValue;
  metadataFields: StageMetadataField[];
  statusOptions: StageFieldOption[];
  disabled: boolean;
  onChange: (value: FeishuStageValue) => void;
  validationErrors: string[];
}

const STAGE_LABELS: Record<FeishuStageId, string> = {
  initial: "初稿",
  first_review: "初审修改",
  final_review: "终审修改",
};

function isAttachmentField(field: StageMetadataField): boolean {
  const type = String(field.uiType ?? field.type ?? "").toLowerCase().replace(/[\s_-]/gu, "");
  return type === "attachment" || type === "attachments" || type === "17";
}

function cloneStage(value: FeishuStageValue): FeishuStageValue {
  return {
    ...value,
    trigger: { ...value.trigger },
    videoSource: { ...value.videoSource },
    reviewSource: { ...value.reviewSource },
    audio: { ...value.audio, source: value.audio.source ? { ...value.audio.source } : value.audio.source },
  };
}

function sourceLabel(source: StageSourceValue): string {
  return source.kind === "docx_section" ? "文档目录" : "Base 附件字段";
}

export function FeishuStageEditor({
  stageId,
  value,
  metadataFields,
  statusOptions,
  disabled,
  onChange,
  validationErrors,
}: FeishuStageEditorProps) {
  const label = STAGE_LABELS[stageId];
  const attachmentFields = metadataFields.filter(isAttachmentField);
  const update = (patch: Partial<FeishuStageValue>) => onChange({ ...cloneStage(value), ...patch });
  const updateSource = (key: "videoSource" | "reviewSource", source: StageSourceValue) => update({ [key]: source } as Partial<FeishuStageValue>);
  const updateAudio = (audio: FeishuStageValue["audio"]) => update({ audio });

  function selectTrigger(event: ChangeEvent<HTMLSelectElement>) {
    const option = statusOptions.find((candidate) => candidate.id === event.target.value);
    update({
      trigger: {
        ...value.trigger,
        optionId: option?.id ?? null,
        value: option?.name ?? "",
      },
    });
  }

  function selectSourceKind(key: "videoSource" | "reviewSource", kind: StageSourceKind) {
    const current = value[key];
    updateSource(key, kind === "docx_section"
      ? { kind, anchorText: current.anchorText ?? "" }
      : { kind, fieldId: current.fieldId ?? attachmentFields[0]?.fieldId ?? "" });
  }

  function sourceControl(key: "videoSource" | "reviewSource", title: string) {
    const source = value[key];
    const docx = source.kind === "docx_section";
    return <div className="feishu-stage-source-group">
      <label>
        <span>{title}来源类型</span>
        <select
          aria-label={`${label}${title}来源类型`}
          value={source.kind}
          disabled={disabled}
          onChange={(event) => selectSourceKind(key, event.target.value as StageSourceKind)}
        >
          <option value="docx_section">文档目录</option>
          {key === "videoSource" && <option value="base_attachment">Base 附件字段</option>}
        </select>
      </label>
      {docx ? (
        <label>
          <span>{title}目录标题</span>
          <input
            aria-label={`${label}${title}目录标题`}
            value={source.anchorText ?? ""}
            disabled={disabled}
            maxLength={512}
            onChange={(event) => updateSource(key, { kind: "docx_section", anchorText: event.target.value })}
            placeholder={title === "视频" ? "例如：录屏" : "例如：修改意见"}
          />
        </label>
      ) : (
        <label>
          <span>{title}附件字段</span>
          <select
            aria-label={`${label}${title}附件字段`}
            value={source.fieldId ?? ""}
            disabled={disabled}
            onChange={(event) => updateSource(key, { kind: "base_attachment", fieldId: event.target.value })}
          >
            <option value="">选择附件字段</option>
            {attachmentFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
          </select>
        </label>
      )}
    </div>;
  }

  return <details className="feishu-stage-editor" open>
    <summary>
      <span className="feishu-stage-summary-main">
        <input
          type="checkbox"
          aria-label={`启用${label}`}
          checked={value.enabled}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <strong>{label}</strong>
      </span>
      <span className={`feishu-stage-state${value.enabled ? " is-enabled" : ""}`}>{value.enabled ? "已启用" : "已关闭"}</span>
    </summary>
    <div className="feishu-stage-editor-body">
      <div className="feishu-stage-grid">
        <label>
          <span>{label}触发选项</span>
          <select
            aria-label={`${label}触发选项`}
            value={value.trigger.optionId ?? ""}
            disabled={disabled || statusOptions.length === 0}
            onChange={selectTrigger}
          >
            <option value="">选择状态选项</option>
            {statusOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        {sourceControl("videoSource", "视频")}
        {sourceControl("reviewSource", "剪辑意见")}
      </div>

      <fieldset className="feishu-stage-audio" disabled={disabled}>
        <legend>声音方式</legend>
        <div className="feishu-stage-segmented" role="group" aria-label={`${label}声音方式`}>
          <button
            type="button"
            className={value.audio.mode === "video_original" ? "is-active" : ""}
            aria-pressed={value.audio.mode === "video_original"}
            onClick={() => updateAudio({ mode: "video_original" })}
          >使用视频原音</button>
          <button
            type="button"
            className={value.audio.mode === "replace_original" ? "is-active" : ""}
            aria-pressed={value.audio.mode === "replace_original"}
            onClick={() => updateAudio({
              mode: "replace_original",
              source: value.audio.source ?? { kind: "base_attachment", fieldId: attachmentFields[0]?.fieldId ?? "" },
              durationToleranceSeconds: value.audio.durationToleranceSeconds ?? 3,
            })}
          >外部音频替换原音</button>
        </div>
        {value.audio.mode === "replace_original" && <div className="feishu-stage-audio-fields">
          <label>
            <span>外部音频来源</span>
            <select
              aria-label="外部音频来源"
              value={value.audio.source?.fieldId ?? ""}
              onChange={(event) => updateAudio({
                ...value.audio,
                source: { kind: "base_attachment", fieldId: event.target.value },
              })}
            >
              <option value="">选择音频附件字段</option>
              {attachmentFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
            </select>
          </label>
          <label>
            <span>时长误差（秒）</span>
            <input
              aria-label="时长误差（秒）"
              type="number"
              min="0.1"
              step="0.1"
              value={value.audio.durationToleranceSeconds ?? 3}
              onChange={(event) => updateAudio({ ...value.audio, durationToleranceSeconds: Number(event.target.value) })}
            />
          </label>
        </div>}
      </fieldset>

      <div className="feishu-stage-grid feishu-stage-output-grid">
        <label>
          <span>ZIP 目标目录</span>
          <input
            aria-label={`${label} ZIP 目标目录`}
            value={value.artifactTargetPath ?? ""}
            disabled={disabled}
            onChange={(event) => update({ artifactTargetPath: event.target.value })}
            placeholder="本机或 NAS 目录"
          />
        </label>
        <label>
          <span>命名后缀</span>
          <input
            aria-label={`${label}命名后缀`}
            value={value.nameSuffix}
            disabled={disabled}
            onChange={(event) => update({ nameSuffix: event.target.value })}
            placeholder={`例如：_${label}`}
          />
        </label>
      </div>

      {validationErrors.length > 0 && <ul className="feishu-stage-errors" role="alert">
        {validationErrors.map((error) => <li key={error}>{error}</li>)}
      </ul>}
      <span className="feishu-stage-source-note">视频：{sourceLabel(value.videoSource)} · 意见：{sourceLabel(value.reviewSource)}</span>
    </div>
  </details>;
}

export const FEISHU_STAGE_LABELS = STAGE_LABELS;

