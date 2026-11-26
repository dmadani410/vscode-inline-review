import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import {
  computeHunks,
  computeStats,
  formatHunkLineRange,
  getHunkPreviewLine,
} from '../diff/diffEngine.js';
import type { ChangeKind } from '../types.js';
import type { ActiveHunkState, ActiveHunkTracker } from './activeHunkTracker.js';
import type { DiffViewManager } from './diffViewManager.js';

interface SerializedHunkItem {
  index: number;
  lineRange: string;
  newStart: number;
  additions: number;
  deletions: number;
  preview: string;
}

interface SerializedFileItem {
  relativePath: string;
  fileName: string;
  dirName: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  hunks: SerializedHunkItem[];
}

interface SidebarStatePayload {
  files: SerializedFileItem[];
  activeHunk: ActiveHunkState;
  activeFilePath: string | null;
  inDiffView: boolean;
  canUndo: boolean;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openFile'; relativePath: string; line?: number }
  | { type: 'selectHunk'; relativePath: string; hunkIndex: number; line: number }
  | { type: 'acceptHunk'; relativePath: string; hunkIndex: number }
  | { type: 'rejectHunk'; relativePath: string; hunkIndex: number }
  | { type: 'acceptFile'; relativePath: string }
  | { type: 'rejectFile'; relativePath: string }
  | { type: 'acceptAll' }
  | { type: 'rejectAll' }
  | { type: 'undo' }
  | { type: 'toggleDiff' }
  | { type: 'toggleSideBySide' }
  | { type: 'prevHunk' }
  | { type: 'nextHunk' }
  | { type: 'importGit' }
  | { type: 'refresh' };

export class PendingWebviewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private isReady = false;

  constructor(
    private readonly controller: BaselineController,
    private readonly diffViewManager: DiffViewManager,
    private readonly activeHunkTracker: ActiveHunkTracker
  ) {
    this.disposables.push(
      this.activeHunkTracker.onDidChange(() => {
        void this.postState();
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.isReady = false;

    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    this.updateBadge();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.postState();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.isReady = false;
      }
    });

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.handleMessage(msg);
    });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.isReady = true;
        await this.postState();
        break;
      case 'openFile':
        await this.diffViewManager.openInlineDiff(msg.relativePath, msg.line);
        break;
      case 'selectHunk':
        this.activeHunkTracker.setSelected({
          relativePath: msg.relativePath,
          hunkIndex: msg.hunkIndex,
        });
        await this.diffViewManager.openInlineDiff(msg.relativePath, msg.line);
        break;
      case 'acceptHunk':
        await vscode.commands.executeCommand(
          'inlineReview.acceptHunk',
          msg.relativePath,
          msg.hunkIndex
        );
        break;
      case 'rejectHunk':
        await vscode.commands.executeCommand(
          'inlineReview.rejectHunk',
          msg.relativePath,
          msg.hunkIndex
        );
        break;
      case 'acceptFile':
        await vscode.commands.executeCommand(
          'inlineReview.acceptFile',
          msg.relativePath
        );
        break;
      case 'rejectFile':
        await vscode.commands.executeCommand(
          'inlineReview.rejectFile',
          msg.relativePath
        );
        break;
      case 'acceptAll':
        await vscode.commands.executeCommand('inlineReview.acceptAll');
        break;
      case 'rejectAll':
        await vscode.commands.executeCommand('inlineReview.rejectAll');
        break;
      case 'undo':
        await vscode.commands.executeCommand('inlineReview.undoLastAction');
        break;
      case 'toggleDiff':
        await vscode.commands.executeCommand('inlineReview.toggleInlineDiff');
        break;
      case 'toggleSideBySide':
        await vscode.commands.executeCommand('inlineReview.toggleSideBySide');
        break;
      case 'prevHunk':
        await vscode.commands.executeCommand('inlineReview.prevHunk');
        break;
      case 'nextHunk':
        await vscode.commands.executeCommand('inlineReview.nextHunk');
        break;
      case 'importGit':
        await vscode.commands.executeCommand('inlineReview.importGitChanges');
        break;
      case 'refresh':
        await vscode.commands.executeCommand('inlineReview.refresh');
        break;
    }
  }

  refresh(): void {
    this.updateBadge();
    void this.postState();
  }

  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const count = this.controller.getAllPending().length;
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} pending file review(s)`,
          }
        : undefined;
  }

  private async buildPayload(): Promise<SidebarStatePayload> {
    const all = this.controller.getAllPending();
    const files: SerializedFileItem[] = [];

    for (const review of all) {
      const fileName = path.posix.basename(review.relativePath);
      const rawDir = path.posix.dirname(review.relativePath);
      const dirName = rawDir === '.' ? '' : rawDir;

      if (review.kind === 'deleted') {
        const hunks = computeHunks(review.baselineContent ?? '', '');
        const stats = computeStats(hunks);
        files.push({
          relativePath: review.relativePath,
          fileName,
          dirName,
          kind: review.kind,
          additions: stats.additions,
          deletions: stats.deletions,
          hunks: [],
        });
        continue;
      }

      const current = await this.controller.readLiveOrDiskContent(
        review.relativePath,
        review.fsPath
      );
      const hunks =
        current !== null
          ? computeHunks(review.baselineContent ?? '', current)
          : [];
      const stats = computeStats(hunks);

      files.push({
        relativePath: review.relativePath,
        fileName,
        dirName,
        kind: review.kind,
        additions: stats.additions,
        deletions: stats.deletions,
        hunks:
          review.kind === 'modified'
            ? hunks.map((h) => ({
                index: h.index,
                lineRange: formatHunkLineRange(h),
                newStart: h.newStart,
                additions: h.newCount,
                deletions: h.oldCount,
                preview: getHunkPreviewLine(h, 64),
              }))
            : [],
      });
    }

    return {
      files,
      activeHunk: this.activeHunkTracker.getState(),
      activeFilePath: this.diffViewManager.getActiveRelativePath(),
      inDiffView: this.diffViewManager.isActiveTabOurDiff(),
      canUndo: this.controller.canUndo(),
    };
  }

  private async postState(): Promise<void> {
    if (!this.view || !this.isReady) {
      return;
    }
    const payload = await this.buildPayload();
    void this.view.webview.postMessage({
      type: 'state',
      payload,
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      background: transparent;
      user-select: none;
    }

    .toolbar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 8px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }

    .toolbar-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
    }

    button {
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      line-height: 1.4;
      padding: 4px 8px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background-color 0.12s ease, opacity 0.12s ease, transform 0.08s ease;
    }
    button:active { transform: translateY(0.5px); }
    button:disabled { opacity: 0.4; cursor: default; }

    .btn-neutral {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .btn-neutral:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.32));
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    /* High-contrast green Accept & red Reject pills */
    .btn-accept {
      background: #238636;
      color: #ffffff;
      font-weight: 600;
    }
    .btn-accept:hover:not(:disabled) {
      background: #2ea043;
    }

    .btn-reject {
      background: #da3633;
      color: #ffffff;
      font-weight: 600;
    }
    .btn-reject:hover:not(:disabled) {
      background: #f85149;
    }

    .btn-sm {
      padding: 2px 7px;
      font-size: 11px;
    }

    .empty-state {
      padding: 14px 6px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .file-card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
    }

    .file-card.active-file {
      border-color: var(--vscode-focusBorder, #388bfd);
    }

    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 8px;
      cursor: pointer;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));
    }
    .file-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.18));
    }

    .file-meta {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .file-title-row {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    .file-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-dir {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .badge-kind {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .badge-created { background: rgba(46, 160, 67, 0.25); color: #3fb950; }
    .badge-deleted { background: rgba(248, 81, 73, 0.25); color: #f85149; }

    .stat-add { color: #3fb950; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 600; }
    .stat-del { color: #f85149; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 600; }

    .hunk-list {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    }

    .hunk-row {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 6px 8px;
      border-left: 3px solid transparent;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12));
      cursor: pointer;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .hunk-row:last-child { border-bottom: none; }
    .hunk-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14));
    }

    /* Single unified highlight for the currently focused/pointed pending hunk */
    .hunk-row.is-active {
      border-left-color: #388bfd;
      background: rgba(56, 139, 253, 0.22);
      box-shadow: inset 0 0 0 1px rgba(56, 139, 253, 0.4);
    }

    .hunk-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .hunk-loc {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .line-pill {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.22));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      flex-shrink: 0;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #388bfd;
      box-shadow: 0 0 6px rgba(56, 139, 253, 0.9);
    }

    .hunk-preview {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hunk-actions {
      display: none;
      align-items: center;
      gap: 6px;
      padding-top: 2px;
    }

    /* Show colored Accept/Reject buttons whenever hunk is active or hovered */
    .hunk-row.is-active .hunk-actions,
    .hunk-row:hover .hunk-actions {
      display: flex;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let collapsedFiles = new Set();
    let lastScrolledKey = '';

    function post(msg) {
      vscode.postMessage(msg);
    }

    function createBtn(label, className, onClick, title, disabled) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = label;
      if (title) btn.title = title;
      if (disabled) btn.disabled = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    }

    function render(state) {
      root.innerHTML = '';

      const hasFiles = state.files.length > 0;
      const activeFileHasPending = Boolean(
        state.activeFilePath &&
        state.files.some((f) => f.relativePath === state.activeFilePath)
      );

      // Extension-pane Toolbar (moved out of Editor Title Bar)
      if (hasFiles || state.canUndo) {
        const toolbar = document.createElement('div');
        toolbar.className = 'toolbar';

        const row1 = document.createElement('div');
        row1.className = 'toolbar-row';
        if (hasFiles) {
          row1.appendChild(
            createBtn('✓ Accept All', 'btn-accept', () => post({ type: 'acceptAll' }), 'Accept all pending files')
          );
          row1.appendChild(
            createBtn('✕ Reject All', 'btn-reject', () => post({ type: 'rejectAll' }), 'Reject all pending files')
          );
        }
        row1.appendChild(
          createBtn('↶ Undo', 'btn-neutral', () => post({ type: 'undo' }), 'Undo last review action (Alt+Z)', !state.canUndo)
        );
        toolbar.appendChild(row1);

        if (hasFiles) {
          const row2 = document.createElement('div');
          row2.className = 'toolbar-row';
          row2.appendChild(
            createBtn(
              state.inDiffView ? 'Normal View' : 'Inline Diff',
              'btn-neutral',
              () => post({ type: 'toggleDiff' }),
              'Toggle Inline Diff / Normal Editor (Alt+R)'
            )
          );
          if (state.inDiffView) {
            row2.appendChild(
              createBtn(
                'Inline / Split',
                'btn-neutral',
                () => post({ type: 'toggleSideBySide' }),
                'Toggle Inline / Side-by-Side layout'
              )
            );
          }
          if (activeFileHasPending) {
            row2.appendChild(
              createBtn('↑ Prev', 'btn-neutral', () => post({ type: 'prevHunk' }), 'Previous hunk (Alt+[)')
            );
            row2.appendChild(
              createBtn('↓ Next', 'btn-neutral', () => post({ type: 'nextHunk' }), 'Next hunk (Alt+])')
            );
          }
          toolbar.appendChild(row2);
        }

        root.appendChild(toolbar);
      }

      if (!hasFiles) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const p = document.createElement('div');
        p.textContent = 'No pending agent edits. External edits from Claude Code, Antigravity, Codex, or any AI agent will appear here automatically.';
        empty.appendChild(p);

        const actions = document.createElement('div');
        actions.className = 'toolbar-row';
        actions.appendChild(
          createBtn('Import Git Uncommitted Changes', 'btn-primary', () => post({ type: 'importGit' }))
        );
        empty.appendChild(actions);
        root.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'file-list';

      let elementToScroll = null;
      let scrollTargetKey = '';

      for (const file of state.files) {
        const card = document.createElement('div');
        card.className = 'file-card' + (state.activeFilePath === file.relativePath ? ' active-file' : '');

        const header = document.createElement('div');
        header.className = 'file-header';
        header.title = file.relativePath;
        header.addEventListener('click', () => {
          post({
            type: 'openFile',
            relativePath: file.relativePath,
            line: file.hunks[0] ? file.hunks[0].newStart : 0,
          });
        });

        const meta = document.createElement('div');
        meta.className = 'file-meta';

        const titleRow = document.createElement('div');
        titleRow.className = 'file-title-row';

        if (file.hunks.length > 0) {
          const isCollapsed = collapsedFiles.has(file.relativePath);
          const chevron = createBtn(
            isCollapsed ? '▸' : '▾',
            'btn-neutral btn-sm',
            () => {
              if (collapsedFiles.has(file.relativePath)) {
                collapsedFiles.delete(file.relativePath);
              } else {
                collapsedFiles.add(file.relativePath);
              }
              render(state);
            },
            'Toggle hunks'
          );
          chevron.style.padding = '0 4px';
          titleRow.appendChild(chevron);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'file-name';
        nameEl.textContent = file.fileName;
        titleRow.appendChild(nameEl);

        if (file.kind === 'created') {
          const badge = document.createElement('span');
          badge.className = 'badge-kind badge-created';
          badge.textContent = 'New';
          titleRow.appendChild(badge);
        } else if (file.kind === 'deleted') {
          const badge = document.createElement('span');
          badge.className = 'badge-kind badge-deleted';
          badge.textContent = 'Del';
          titleRow.appendChild(badge);
        } else {
          const add = document.createElement('span');
          add.className = 'stat-add';
          add.textContent = '+' + file.additions;
          const del = document.createElement('span');
          del.className = 'stat-del';
          del.textContent = '-' + file.deletions;
          titleRow.appendChild(add);
          titleRow.appendChild(del);
        }

        meta.appendChild(titleRow);

        if (file.dirName) {
          const dirEl = document.createElement('div');
          dirEl.className = 'file-dir';
          dirEl.textContent = file.dirName;
          meta.appendChild(dirEl);
        }

        header.appendChild(meta);

        const fileActions = document.createElement('div');
        fileActions.className = 'file-actions';
        fileActions.appendChild(
          createBtn('✓', 'btn-accept btn-sm', () => post({ type: 'acceptFile', relativePath: file.relativePath }), 'Accept File')
        );
        fileActions.appendChild(
          createBtn('✕', 'btn-reject btn-sm', () => post({ type: 'rejectFile', relativePath: file.relativePath }), 'Reject File')
        );
        header.appendChild(fileActions);

        card.appendChild(header);

        if (file.hunks.length > 0 && !collapsedFiles.has(file.relativePath)) {
          const hunkList = document.createElement('div');
          hunkList.className = 'hunk-list';
          const activeTarget = state.activeHunk.hovered || state.activeHunk.selected;

          for (const h of file.hunks) {
            const isActive = Boolean(
              activeTarget &&
              activeTarget.relativePath === file.relativePath &&
              activeTarget.hunkIndex === h.index
            );

            const row = document.createElement('div');
            row.className = 'hunk-row' + (isActive ? ' is-active' : '');

            row.addEventListener('click', () => {
              post({
                type: 'selectHunk',
                relativePath: file.relativePath,
                hunkIndex: h.index,
                line: h.newStart,
              });
            });

            const top = document.createElement('div');
            top.className = 'hunk-top';

            const loc = document.createElement('div');
            loc.className = 'hunk-loc';

            if (isActive) {
              const dot = document.createElement('span');
              dot.className = 'status-dot';
              loc.appendChild(dot);
            }

            const linePill = document.createElement('span');
            linePill.className = 'line-pill';
            linePill.textContent = h.lineRange;
            loc.appendChild(linePill);

            const add = document.createElement('span');
            add.className = 'stat-add';
            add.textContent = '+' + h.additions;
            const del = document.createElement('span');
            del.className = 'stat-del';
            del.textContent = '-' + h.deletions;
            loc.appendChild(add);
            loc.appendChild(del);

            top.appendChild(loc);
            row.appendChild(top);

            if (h.preview) {
              const prev = document.createElement('div');
              prev.className = 'hunk-preview';
              prev.textContent = h.preview;
              row.appendChild(prev);
            }

            const actions = document.createElement('div');
            actions.className = 'hunk-actions';
            actions.appendChild(
              createBtn(
                '✓ Accept',
                'btn-accept btn-sm',
                () => post({ type: 'acceptHunk', relativePath: file.relativePath, hunkIndex: h.index }),
                'Accept this change (Alt+Y)'
              )
            );
            actions.appendChild(
              createBtn(
                '✕ Reject',
                'btn-reject btn-sm',
                () => post({ type: 'rejectHunk', relativePath: file.relativePath, hunkIndex: h.index }),
                'Reject this change (Alt+N)'
              )
            );
            row.appendChild(actions);

            if (isActive) {
              elementToScroll = row;
              scrollTargetKey = file.relativePath + ':' + h.index;
            }

            hunkList.appendChild(row);
          }

          card.appendChild(hunkList);
        }

        list.appendChild(card);
      }

      root.appendChild(list);

      if (elementToScroll && scrollTargetKey !== lastScrolledKey) {
        lastScrolledKey = scrollTargetKey;
        elementToScroll.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'state') {
        render(msg.payload);
      }
    });

    post({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
