import * as vscode from 'vscode';
import { BaselineController } from './baseline/baselineController.js';
import { GitService } from './baseline/gitService.js';
import { ReviewStore } from './baseline/reviewStore.js';
import { findTargetHunkIndex } from './diff/diffEngine.js';
import { UndoStack } from './diff/undoStack.js';
import {
  BASELINE_SCHEME,
  BaselineContentProvider,
  DELETED_SCHEME,
} from './ui/baselineContentProvider.js';
import { InlineReviewCodeLensProvider } from './ui/codeLensProvider.js';
import { DecorationManager } from './ui/decorations.js';
import { DiffViewManager } from './ui/diffViewManager.js';
import {
  PendingTreeItem,
  PendingTreeProvider,
} from './ui/pendingTreeProvider.js';
import { QuickDiffManager } from './ui/quickDiffProvider.js';
import { StatusBarManager } from './ui/statusBar.js';

let activeDiffViewManager: DiffViewManager | undefined;

function extractRelativePathArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const obj = arg as Partial<PendingTreeItem>;
    if (obj.nodeType === 'file' && obj.review) {
      return obj.review.relativePath;
    }
    if (obj.nodeType === 'hunk') {
      return obj.relativePath;
    }
  }
  return undefined;
}

function extractHunkArgs(
  arg1: unknown,
  arg2: unknown
): { relativePath?: string; hunkIndex?: number } {
  if (typeof arg1 === 'string' && typeof arg2 === 'number') {
    return { relativePath: arg1, hunkIndex: arg2 };
  }
  if (arg1 && typeof arg1 === 'object') {
    const obj = arg1 as Partial<PendingTreeItem>;
    if (obj.nodeType === 'hunk' && obj.hunk) {
      return { relativePath: obj.relativePath, hunkIndex: obj.hunk.index };
    }
  }
  return {};
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const store = new ReviewStore();
  const undoStack = new UndoStack(100);
  const gitService = new GitService(workspaceRoot);
  const controller = new BaselineController(
    context,
    workspaceRoot,
    store,
    undoStack,
    gitService
  );

  const baselineContentProvider = new BaselineContentProvider(controller);
  const diffViewManager = new DiffViewManager(context, controller);
  activeDiffViewManager = diffViewManager;

  const codeLensProvider = new InlineReviewCodeLensProvider(
    controller,
    diffViewManager
  );
  const decorationManager = new DecorationManager(controller, diffViewManager);
  const quickDiffManager = new QuickDiffManager(workspaceFolder, controller);
  const treeProvider = new PendingTreeProvider(controller);
  const statusBar = new StatusBarManager(controller);

  const treeView = vscode.window.createTreeView('inlineReview.pendingFiles', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  treeProvider.attachTreeView(treeView);

  const syncContextKeys = async () => {
    const hasPending = controller.getAllPending().length > 0;
    const activeRel = diffViewManager.getActiveRelativePath();
    const activePending = activeRel ? controller.hasPending(activeRel) : false;
    const inDiff = diffViewManager.isActiveTabOurDiff();
    const canUndo = controller.canUndo();

    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'inlineReview.hasPendingFiles',
        hasPending
      ),
      vscode.commands.executeCommand(
        'setContext',
        'inlineReview.activeFileHasPending',
        activePending
      ),
      vscode.commands.executeCommand('setContext', 'inlineReview.inDiffView', inDiff),
      vscode.commands.executeCommand('setContext', 'inlineReview.canUndo', canUndo),
    ]);
  };

  const refreshAllUi = (relativePath?: string) => {
    baselineContentProvider.refresh(relativePath);
    codeLensProvider.refresh();
    decorationManager.updateAllVisibleEditors();
    quickDiffManager.refresh();
    treeProvider.refresh();
    void statusBar.refresh();
    void syncContextKeys();
  };

  const handleActionResult = (res: { ok: boolean; message?: string }) => {
    if (!res.ok && res.message) {
      void vscode.window.showInformationMessage(res.message);
    } else if (res.ok && res.message) {
      vscode.window.setStatusBarMessage(res.message, 3500);
    }
  };

  const jumpToHunk = (editor: vscode.TextEditor, line: number) => {
    const clamped = Math.max(
      0,
      Math.min(line, Math.max(0, editor.document.lineCount - 1))
    );
    const pos = new vscode.Position(clamped, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  };

  const actOnCurrentHunk = async (mode: 'accept' | 'reject') => {
    const rel = diffViewManager.getActiveRelativePath();
    if (!rel || !controller.hasPending(rel)) {
      return;
    }

    const pending = controller.getPending(rel);
    if (pending && (pending.kind === 'created' || pending.kind === 'deleted')) {
      const res =
        mode === 'accept'
          ? await controller.acceptFile(rel)
          : await controller.rejectFile(rel);
      handleActionResult(res);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const hunks = await controller.getHunksForPending(rel);
    if (hunks.length === 0) {
      return;
    }

    const cursorLine = editor ? editor.selection.active.line : 0;
    const { exactOrNearIndex, nextIndex } = findTargetHunkIndex(hunks, cursorLine);

    if (exactOrNearIndex === null) {
      if (editor && nextIndex !== null) {
        jumpToHunk(editor, hunks[nextIndex].newStart);
        vscode.window.setStatusBarMessage(
          `Inline Review: Jumped to hunk #${nextIndex + 1} — press again to ${mode}`,
          3000
        );
      }
      return;
    }

    const res =
      mode === 'accept'
        ? await controller.acceptHunk(rel, exactOrNearIndex)
        : await controller.rejectHunk(rel, exactOrNearIndex);
    handleActionResult(res);
  };

  const navigateHunk = async (direction: 1 | -1) => {
    const rel = diffViewManager.getActiveRelativePath();
    const editor = vscode.window.activeTextEditor;
    if (!rel || !editor) {
      return;
    }

    const hunks = await controller.getHunksForPending(rel);
    if (hunks.length === 0) {
      return;
    }

    const cursorLine = editor.selection.active.line;
    let targetIndex = 0;

    if (direction === 1) {
      const idx = hunks.findIndex((h) => h.newStart > cursorLine);
      targetIndex = idx >= 0 ? idx : 0;
    } else {
      let idx = -1;
      for (let i = hunks.length - 1; i >= 0; i -= 1) {
        if (hunks[i].newStart < cursorLine) {
          idx = i;
          break;
        }
      }
      targetIndex = idx >= 0 ? idx : hunks.length - 1;
    }

    jumpToHunk(editor, hunks[targetIndex].newStart);
  };

  context.subscriptions.push(
    controller,
    baselineContentProvider,
    diffViewManager,
    codeLensProvider,
    decorationManager,
    quickDiffManager,
    treeProvider,
    treeView,
    statusBar,

    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      baselineContentProvider
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      DELETED_SCHEME,
      baselineContentProvider
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: 'file' }, { scheme: DELETED_SCHEME }],
      codeLensProvider
    ),

    controller.onDidChange((rel) => refreshAllUi(rel)),
    controller.onDidFileResolved((rel) => {
      void diffViewManager.returnToNormalTabIfResolved(rel);
    }),

    vscode.window.onDidChangeActiveTextEditor(() => {
      decorationManager.updateAllVisibleEditors();
      codeLensProvider.refresh();
      void syncContextKeys();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      decorationManager.updateAllVisibleEditors();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      decorationManager.updateAllVisibleEditors();
      codeLensProvider.refresh();
      void syncContextKeys();
    }),

    vscode.commands.registerCommand(
      'inlineReview.openInlineDiff',
      async (arg?: unknown, line?: number) => {
        const rel =
          extractRelativePathArg(arg) ??
          diffViewManager.getActiveRelativePath() ??
          controller.getAllPending()[0]?.relativePath;
        if (!rel) {
          void vscode.window.showInformationMessage('No pending inline reviews.');
          return;
        }
        const jumpLine =
          typeof line === 'number'
            ? line
            : arg &&
                typeof arg === 'object' &&
                (arg as PendingTreeItem).nodeType === 'hunk'
              ? (arg as { hunk: { newStart: number } }).hunk.newStart
              : undefined;
        await diffViewManager.openInlineDiff(rel, jumpLine);
      }
    ),

    vscode.commands.registerCommand(
      'inlineReview.toggleInlineDiff',
      async (arg?: unknown) => {
        const rel = extractRelativePathArg(arg);
        await diffViewManager.toggleInlineDiff(rel);
      }
    ),

    vscode.commands.registerCommand('inlineReview.toggleSideBySide', async () => {
      await diffViewManager.toggleSideBySideInDiff();
    }),

    vscode.commands.registerCommand(
      'inlineReview.acceptHunk',
      async (arg1?: unknown, arg2?: unknown) => {
        const { relativePath, hunkIndex } = extractHunkArgs(arg1, arg2);
        if (relativePath && hunkIndex !== undefined) {
          handleActionResult(await controller.acceptHunk(relativePath, hunkIndex));
          return;
        }
        await actOnCurrentHunk('accept');
      }
    ),

    vscode.commands.registerCommand(
      'inlineReview.rejectHunk',
      async (arg1?: unknown, arg2?: unknown) => {
        const { relativePath, hunkIndex } = extractHunkArgs(arg1, arg2);
        if (relativePath && hunkIndex !== undefined) {
          handleActionResult(await controller.rejectHunk(relativePath, hunkIndex));
          return;
        }
        await actOnCurrentHunk('reject');
      }
    ),

    vscode.commands.registerCommand(
      'inlineReview.acceptCurrentHunk',
      async () => actOnCurrentHunk('accept')
    ),

    vscode.commands.registerCommand(
      'inlineReview.rejectCurrentHunk',
      async () => actOnCurrentHunk('reject')
    ),

    vscode.commands.registerCommand(
      'inlineReview.acceptFile',
      async (arg?: unknown) => {
        const rel =
          extractRelativePathArg(arg) ?? diffViewManager.getActiveRelativePath();
        if (!rel) {
          return;
        }
        handleActionResult(await controller.acceptFile(rel));
      }
    ),

    vscode.commands.registerCommand(
      'inlineReview.rejectFile',
      async (arg?: unknown) => {
        const rel =
          extractRelativePathArg(arg) ?? diffViewManager.getActiveRelativePath();
        if (!rel) {
          return;
        }
        handleActionResult(await controller.rejectFile(rel));
      }
    ),

    vscode.commands.registerCommand('inlineReview.acceptCurrentFile', async () => {
      const rel = diffViewManager.getActiveRelativePath();
      if (rel) {
        handleActionResult(await controller.acceptFile(rel));
      }
    }),

    vscode.commands.registerCommand('inlineReview.rejectCurrentFile', async () => {
      const rel = diffViewManager.getActiveRelativePath();
      if (rel) {
        handleActionResult(await controller.rejectFile(rel));
      }
    }),

    vscode.commands.registerCommand('inlineReview.acceptAll', async () => {
      await controller.acceptAll();
    }),

    vscode.commands.registerCommand('inlineReview.rejectAll', async () => {
      await controller.rejectAll();
    }),

    vscode.commands.registerCommand('inlineReview.nextHunk', async () => {
      await navigateHunk(1);
    }),

    vscode.commands.registerCommand('inlineReview.prevHunk', async () => {
      await navigateHunk(-1);
    }),

    vscode.commands.registerCommand('inlineReview.nextPendingFile', async () => {
      const all = controller.getAllPending();
      if (all.length === 0) {
        void vscode.window.showInformationMessage('All pending edits have been reviewed.');
        return;
      }
      const activeRel = diffViewManager.getActiveRelativePath();
      const currentIndex = activeRel
        ? all.findIndex((item) => item.relativePath === activeRel)
        : -1;
      const next = all[(currentIndex + 1) % all.length];
      await diffViewManager.openInlineDiff(next.relativePath);
    }),

    vscode.commands.registerCommand('inlineReview.undoLastAction', async () => {
      handleActionResult(await controller.undoLastAction());
    }),

    vscode.commands.registerCommand('inlineReview.importGitChanges', async () => {
      const count = await controller.importGitChanges();
      if (count > 0) {
        vscode.window.setStatusBarMessage(
          `Inline Review: Imported ${count} changed file(s) from Git.`,
          3500
        );
      } else {
        void vscode.window.showInformationMessage(
          'No uncommitted Git changes found to import.'
        );
      }
    }),

    vscode.commands.registerCommand('inlineReview.refresh', async () => {
      await controller.refreshAll();
    })
  );

  await diffViewManager.initialize();
  await controller.initialize();
  refreshAllUi();
}

export async function deactivate(): Promise<void> {
  if (activeDiffViewManager) {
    await activeDiffViewManager.restoreGlobalSideBySideIfNeeded();
    activeDiffViewManager = undefined;
  }
}
