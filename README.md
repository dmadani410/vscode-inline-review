# Inline Review (`vscode-inline-review`)

Review AI agent edits inline in VS Code — accept, reject, or edit changes hunk by hunk.

Works out of the box with **Claude Code (CLI & extension), Antigravity, Codex, Gemini CLI, Aider, Cline, OpenCode**, and any other local tool or agent that modifies workspace files.

---

## Features

- **Universal Agent Support (Zero Config)**
  - Uses incremental baselines (Git index/HEAD for clean files + automatic pre-agent snapshots for dirty uncommitted files) to capture external agent edits without requiring agent-specific plugins or hooks.
- **Hybrid Dual-Mode Inline Diff**
  - **Primary Review View**: Opens a native single-column Inline Diff (`inline-review-baseline://` vs your real editable workspace file), preserving full IntelliSense, diagnostics, Go to Definition, and direct line-by-line editing.
  - **Normal Editor Sync**: Pending files in normal editor tabs show green line highlights, red deletion markers with hover previews of removed code, gutter QuickDiff indicators, and inline CodeLens actions.
  - **Isolated Inline Setting**: Automatically switches `diffEditor.renderSideBySide` to inline mode only while focused on an Inline Review diff tab, and restores your original global setting when switching away (never modifies `.vscode/settings.json`).
- **Hunk & File Approval + Direct Editing**
  - Accept or reject individual hunks (`Accept Hunk` / `Reject Hunk`) or entire files (`Accept File` / `Reject File`).
  - Edit any line directly inside the diff or normal tab; manual edits are preserved and approved together with the hunk.
  - Automatically returns to the normal editor tab once the last hunk of a file is resolved.
- **Safe Undo (`Undo Last Review Action`)**
  - **Undo Accept**: Losslessly rolls back the baseline without touching your file — subsequent manual or agent edits stay 100% intact.
  - **Undo Reject**: Uses deterministic **3-way merge** to relocate lines when non-overlapping edits happened afterward, and blocks with a conflict warning instead of overwriting if overlapping edits occurred.
- **Queue, Trash Safety & Persistence**
  - Pending files and hunks are listed in the **Inline Review** Activity Bar sidebar and status bar without stealing editor focus.
  - Rejecting newly created files moves them to the OS Trash; rejecting deleted files restores them from baseline.
  - Pending baselines persist across VS Code restarts.

---

## Default Keyboard Shortcuts

| Action | Shortcut (Windows/Linux) | Context |
| :--- | :--- | :--- |
| Accept Current Hunk | `Alt+Y` | Editor focused & file has pending review |
| Reject Current Hunk | `Alt+N` | Editor focused & file has pending review |
| Accept Current File | `Alt+Shift+Y` | File has pending review |
| Reject Current File | `Alt+Shift+N` | File has pending review |
| Next Hunk | `Alt+]` | Editor focused & file has pending review |
| Previous Hunk | `Alt+[` | Editor focused & file has pending review |
| Toggle Inline Diff View | `Alt+R` | Has pending files |
| Next Pending File | `Alt+Shift+]` | Has pending files |
| Undo Last Review Action | `Alt+Z` | Undo history available |

---

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `inlineReview.enabled` | `true` | Enable automatic detection of external edits |
| `inlineReview.autoInlineDiff` | `true` | Auto-enable inline diff layout only on Inline Review tabs and restore afterward |
| `inlineReview.autoSaveOnReject` | `true` | Automatically save the document after rejecting a hunk or file |
| `inlineReview.excludePatterns` | `[]` | Extra glob patterns to ignore |
| `inlineReview.maxFileSizeKB` | `2048` | Max file size in KB to track |
| `inlineReview.maxBurstFiles` | `50` | Prompt confirmation if a single write burst exceeds this count |
| `inlineReview.persistState` | `true` | Persist pending review baselines across restarts |

---

## Build & Install Locally

```bash
npm install
npm run typecheck
npm test
npm run package
code --install-extension vscode-inline-review-0.1.0.vsix
```
