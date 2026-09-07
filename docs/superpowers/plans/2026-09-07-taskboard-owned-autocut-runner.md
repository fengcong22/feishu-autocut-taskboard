# Taskboard-Owned Auto-Cut Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run trusted phased Auto-Cut work as a Taskboard-owned local subprocess so the preflight and long edit no longer depend on a Codex conversation polling the process.

**Architecture:** Keep the current Taskboard claim, immutable run preparation, result/receipt validation, `driver_report`, and completion/upload reconciliation. Replace only the phased execution boundary: Taskboard resolves the registered package's installed runtime, spawns `review-document-run` once with the exact run paths, then posts the exact ZIP and SHA-256 through the existing loopback artifact-report route before reconciling the synthetic local run. Legacy and ordinary tasks retain the Codex path.

**Tech Stack:** Node.js ESM, built-in `node:test`, child-process `spawn`, existing SQLite and artifact services.

## Global Constraints

- Do not create another FEI-3 run while implementing or verifying this change.
- Keep Taskboard and Bridge on `127.0.0.1`, do not write Feishu records, and never promote a Feishu cell value to a path, command, or prompt.
- Never scan an output directory or infer a run from a filename or newest ZIP.
- Preserve user-owned `pip/` and unrelated worktree changes.
- Stop for user confirmation after direct verification; do not merge, release, or start Pro review yet.

---

### Task 1: Direct phased execution and reconciliation

**Files:**
- Create: `server/autocut-local-runner.mjs`
- Modify: `server/app.mjs`
- Test: `test/feishu-autocut-run-lifecycle.test.mjs`

**Interfaces:**
- Consumes: the existing prepared phased run (`manifestPath`, `executionInputPath`, `draftsRoot`, `resultPath`, `packageZipPath`) and the registered package snapshot/workspace.
- Produces: one terminal local run whose exact result and ZIP flow through the existing artifact and task reconciliation code.

- [ ] Add a focused lifecycle test with a fake local Auto-Cut executable; assert the task completes and no Codex turn is invoked.
- [ ] Run only that test and observe it fail because the current implementation invokes Codex instead of the local runner.
- [ ] Implement the smallest local runner and route phased starts to it while retaining the legacy Codex path.
- [ ] Reuse the existing artifact-report boundary and reconciliation; do not duplicate ZIP discovery or ownership logic.
- [ ] Run the focused failing path and successful automatic/manual main paths.
- [ ] Commit the directly verified change and report its exact SHA for user confirmation.
