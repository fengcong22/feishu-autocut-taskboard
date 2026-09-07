import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuStageEditor } from "./FeishuStageEditor";

const fields = [
  {
    fieldId: "fld_status",
    fieldName: "流程状态",
    type: "single_select",
    uiType: "SingleSelect",
    options: [
      { id: "opt_initial", name: "初稿" },
      { id: "opt_review", name: "初审修改" },
      { id: "opt_final", name: "终审修改" },
    ],
  },
  { fieldId: "fld_video", fieldName: "视频附件", type: "attachment", uiType: "Attachment", options: [] },
  { fieldId: "fld_audio", fieldName: "配音附件", type: "attachment", uiType: "Attachment", options: [] },
];

const stage = {
  enabled: true,
  trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_initial", value: "初稿" },
  videoSource: { kind: "docx_section", anchorText: "录屏" },
  reviewSource: { kind: "docx_section", anchorText: "修改意见" },
  audio: { mode: "video_original" },
  artifactTargetPath: "C:\\approved\\initial",
  nameSuffix: "_初稿",
} as const;

describe("FeishuStageEditor", () => {
  afterEach(() => cleanup());

  it("renders one fixed stage and only the selected status options", async () => {
    const onChange = vi.fn();
    render(
      <FeishuStageEditor
        stageId="initial"
        value={stage as never}
        metadataFields={fields}
        statusOptions={fields[0].options}
        disabled={false}
        onChange={onChange}
        validationErrors={[]}
      />,
    );

    expect((screen.getByRole("checkbox", { name: "启用初稿" }) as HTMLInputElement).checked).toBe(true);
    const trigger = screen.getByRole("combobox", { name: "初稿触发选项" });
    expect(trigger).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByRole("option", { name: "初稿" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "初审修改" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "终审修改" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "启用初稿" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("shows an audio source only for replace_original", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FeishuStageEditor
        stageId="initial"
        value={stage as never}
        metadataFields={fields}
        statusOptions={fields[0].options}
        disabled={false}
        onChange={onChange}
        validationErrors={[]}
      />,
    );
    expect(screen.queryByLabelText("外部音频来源")).toBeNull();

    rerender(
      <FeishuStageEditor
        stageId="initial"
        value={{ ...stage, audio: { mode: "replace_original", source: { kind: "base_attachment", fieldId: "fld_audio" }, durationToleranceSeconds: 3 } } as never}
        metadataFields={fields}
        statusOptions={fields[0].options}
        disabled={false}
        onChange={onChange}
        validationErrors={[]}
      />,
    );
    expect(screen.getByLabelText("外部音频来源")).toBeTruthy();
    expect((screen.getByLabelText("时长误差（秒）") as HTMLInputElement).value).toBe("3");
  });
});
