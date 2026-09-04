# Remote Integration and Standalone Release Plan

> **For agentic workers:** Execute this plan inline in the current checkout. Do not create a parallel feature branch, modify the `codex-feishu` repository, or merge the integration branch into this repository's `main`.

**Goal:** Preserve the current Auto-Cut integration, merge the latest `origin/main` into `codex/feishu-autocut-workflow`, verify the result, and publish the verified feature version as `main` in the independent `feishu-autocut-taskboard` repository.

**Architecture:** The existing Taskboard checkout remains the only working repository. A date-stamped remote tag records the pre-merge commit, `origin/main` is merged into the current branch in place, and a separate named remote points at the empty standalone GitHub repository for the final `main` push. The standalone release adds repository-level Apache 2.0 licensing and bilingual source attribution without changing runtime behavior.

**Tech Stack:** Git, Node.js 22.5+, TypeScript, Vite, Node test runner, React, SQLite-backed local server.

## Global Constraints

- Keep the current branch name `codex/feishu-autocut-workflow`.
- Do not create a parallel feature branch.
- Do not modify or run commands in `D:\codex\codex-feishu`.
- Do not merge this branch into the current repository's `main`.
- Keep credentials, `.data\\`, `.runtime\\`, `dist\\`, and `node_modules\\` out of commits and pushes.
- Run fresh verification before reporting completion or pushing the standalone `main`.

---

### Task 1: Record the pre-merge state and remote backup

**Files:**
- Read: `git status`, `git rev-parse`, and remote refs
- Create remotely: date-stamped backup tag pointing to the current commit

- [ ] **Step 1: Fetch the latest `origin` refs and record the clean starting state.**

```powershell
git fetch origin --prune
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

- [ ] **Step 2: Push the current commit as a non-branch backup tag.**

```powershell
git push origin HEAD:refs/tags/backup/feishu-autocut-workflow-20260904
```

- [ ] **Step 3: Verify the backup tag resolves to the recorded pre-merge commit.**

```powershell
git ls-remote --tags origin refs/tags/backup/feishu-autocut-workflow-20260904
```

### Task 2: Merge `origin/main` into the current integration branch

**Files:**
- Modify only files required by merge conflicts

- [ ] **Step 1: Merge the fetched `origin/main` while staying on the current branch.**

```powershell
git merge --no-edit origin/main
```

- [ ] **Step 2: Classify every conflict by file and preserve both the upstream fix and the Auto-Cut integration behavior.**

```powershell
git status --short
git diff --name-only --diff-filter=U
git diff --check
```

- [ ] **Step 3: Complete the merge and verify the index has no unresolved paths.**

```powershell
git add --update
git commit
git diff --name-only --diff-filter=U
git status --short --branch
```

### Task 3: Run complete repository verification

**Files:**
- Read: repository source, tests, and merge result

- [ ] **Step 1: Run the repository's complete check command.**

```powershell
npm run check
```

- [ ] **Step 2: Run the standalone cloud suite and whitespace check if the complete check does not include them.**

```powershell
npm run test:cloud
git diff --check origin/main...HEAD
```

- [ ] **Step 3: Inspect the final branch and ensure ignored runtime data is not staged.**

```powershell
git status --short --branch
git diff --cached --name-only
git ls-files .data .runtime dist node_modules
```

### Task 4: Add Apache 2.0 licensing and source attribution

**Files:**
- Create: `LICENSE`
- Create: `NOTICE.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add the complete Apache License 2.0 text to `LICENSE`.**

- [ ] **Step 2: Add `NOTICE.md` identifying the independent repository, the source repository, and the scope of the Apache 2.0 notice.**

- [ ] **Step 3: Add matching English and Chinese license/source sections to both READMEs, linking to the canonical source and independent release repositories.**

- [ ] **Step 4: Verify the documentation diff, then commit only the license and source-notice files.**

```powershell
git diff --check
git add LICENSE NOTICE.md README.md README.zh-CN.md
git commit -m "docs: add Apache 2.0 license and source notice"
```

### Task 5: Publish the verified feature version to the independent repository

**Files:**
- Remote only: `https://github.com/fengcong22/feishu-autocut-taskboard`

- [ ] **Step 1: Add or verify the named standalone remote without changing `origin`.**

```powershell
git remote add standalone https://github.com/fengcong22/feishu-autocut-taskboard.git
git remote get-url standalone
```

- [ ] **Step 2: Re-run the required verification immediately before publishing.**

```powershell
npm run check
git diff --check
```

- [ ] **Step 3: Push the verified current feature version as the standalone repository's `main`.**

```powershell
git push standalone HEAD:refs/heads/main
```

- [ ] **Step 4: Verify the published `main` commit and leave the current checkout on `codex/feishu-autocut-workflow`.**

```powershell
git ls-remote --heads standalone main
git status --short --branch
```
