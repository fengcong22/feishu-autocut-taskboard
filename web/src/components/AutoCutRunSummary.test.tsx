import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCutRunSummary } from "./AutoCutRunSummary";

describe("AutoCutRunSummary", () => {
  afterEach(() => cleanup());

  it("shows the blocking reason and sends an explicit retry for a blocked task", async () => {
    const onRetry = vi.fn();
    const task = { id: "task-1", version: 4, status: "blocked" };
    const attempt = {
      runId: "run-1",
      attempt: 1,
      stageId: "initial",
      state: "blocked",
      manifestSha256: "a".repeat(64),
      errorCode: "docx_anchor_missing",
      errorMessage: "未找到录屏目录",
    };
    render(<AutoCutRunSummary task={task} attempts={[attempt]} retrying={false} onRetry={onRetry} />);

    expect(screen.getByText("docx_anchor_missing")).toBeTruthy();
    expect(screen.getByText("run-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试 Auto-Cut" }));
    expect(onRetry).toHaveBeenCalledWith("task-1", 4);
  });

  it("does not expose private source paths or report credentials", () => {
    render(
      <AutoCutRunSummary
        task={{ id: "task-1", version: 4, status: "in_progress" }}
        attempts={[{ runId: "run-2", attempt: 2, stageId: "first_review", state: "prepared", manifestSha256: "b".repeat(64) }]}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toMatch(/C:\\|tmp|token|secret|feishu\.cn/i);
  });
});
