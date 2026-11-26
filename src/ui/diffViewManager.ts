import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { toPosixRelative } from '../baseline/noiseFilter.js';
import {
  BASELINE_SCHEME,
  buildBaselineUri,
  buildDeletedUri,
  DELETED_SCHEME,
  parseRelativePathFromVirtualUri,
} from './baselineContentProvider.js';

const SAVED_SIDE_BY_SIDE_KEY = 'inlineReview.savedRenderSideBySide';

type SavedSettingValue = boolean | null | undefined;

export class DiffViewManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private manualOverrideSideBySide = false;
  private isApplyingSetting = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: BaselineController
  ) {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        void this.syncInlineDiffSetting();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.syncInlineDiffSetting();
      })
    );
  }

  async initialize(): Promise<void> {
    // Crash recovery: if a previous session left our override behind, restore immediately when not on our tab.
    await this.syncInlineDiffSetting();
  }

  isOurDiffTab(tab: vscode.Tab | undefined): boolean {
    if (!tab) {
      return false;
    }
    if (tab.input instanceof vscode.TabInputTextDiff) {
      return tab.input.original.scheme === BASELINE_SCHEME;
    }
    return false;
  }

  isActiveTabOurDiff(): boolean {
    return this.isOurDiffTab(vscode.window.tabGroups.activeTabGroup.activeTab);
  }

  getRelativePathFromTab(tab: vscode.Tab | undefined): string | null {
    if (!tab) {
      return null;
    }
    if (tab.input instanceof vscode.TabInputTextDiff) {
      if (tab.input.original.scheme === BASELINE_SCHEME) {
        return parseRelativePathFromVirtualUri(tab.input.original);
      }
      if (tab.input.modified.scheme === 'file') {
        return toPosixRelative(
          this.controller.workspaceRoot,
          tab.input.modified.fsPath
        );
      }
    }
    if (tab.input instanceof vscode.TabInputText) {
      if (tab.input.uri.scheme === 'file') {
        return toPosixRelative(
          this.controller.workspaceRoot,
          tab.input.uri.fsPath
        );
      }
      if (tab.input.uri.scheme === DELETED_SCHEME) {
        return parseRelativePathFromVirtualUri(tab.input.uri);
      }
    }
    return null;
  }

  getActiveRelativePath(): string | null {
    const fromTab = this.getRelativePathFromTab(
      vscode.window.tabGroups.activeTabGroup.activeTab
    );
    if (fromTab) {
      return fromTab;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    if (editor.document.uri.scheme === 'file') {
      return toPosixRelative(
        this.controller.workspaceRoot,
        editor.document.uri.fsPath
      );
    }
    if (
      editor.document.uri.scheme === BASELINE_SCHEME ||
      editor.document.uri.scheme === DELETED_SCHEME
    ) {
      return parseRelativePathFromVirtualUri(editor.document.uri);
    }
    return null;
  }

  async syncInlineDiffSetting(): Promise<void> {
    if (this.isApplyingSetting) {
      return;
    }

    const autoInline = vscode.workspace
      .getConfiguration('inlineReview')
      .get<boolean>('autoInlineDiff', true);

    const onOurTab = this.isActiveTabOurDiff();
    if (!onOurTab) {
      this.manualOverrideSideBySide = false;
      await this.restoreGlobalSideBySideIfNeeded();
      return;
    }

    if (!autoInline || this.manualOverrideSideBySide) {
      return;
    }

    await this.activateGlobalInlineMode();
  }

  private async activateGlobalInlineMode(): Promise<void> {
    const diffCfg = vscode.workspace.getConfiguration('diffEditor');
    const inspected = diffCfg.inspect<boolean>('renderSideBySide');
    const currentEffective = diffCfg.get<boolean>('renderSideBySide', true);

    const alreadySaved = this.context.globalState.get<SavedSettingValue>(
      SAVED_SIDE_BY_SIDE_KEY
    );

    if (alreadySaved === undefined && currentEffective !== false) {
      const toSave: boolean | null =
        inspected?.globalValue === undefined ? null : inspected.globalValue;
      await this.context.globalState.update(SAVED_SIDE_BY_SIDE_KEY, toSave);
    }

    if (currentEffective !== false) {
      this.isApplyingSetting = true;
      try {
        await diffCfg.update(
          'renderSideBySide',
          false,
          vscode.ConfigurationTarget.Global
        );
      } finally {
        this.isApplyingSetting = false;
      }
    }
  }

  async restoreGlobalSideBySideIfNeeded(): Promise<void> {
    const saved = this.context.globalState.get<SavedSettingValue>(
      SAVED_SIDE_BY_SIDE_KEY
    );
    if (saved === undefined) {
      return;
    }

    const diffCfg = vscode.workspace.getConfiguration('diffEditor');
    const restoreValue = saved === null ? undefined : saved;

    this.isApplyingSetting = true;
    try {
      await diffCfg.update(
        'renderSideBySide',
        restoreValue,
        vscode.ConfigurationTarget.Global
      );
      await this.context.globalState.update(SAVED_SIDE_BY_SIDE_KEY, undefined);
    } finally {
      this.isApplyingSetting = false;
    }
  }

  async toggleSideBySideInDiff(): Promise<void> {
    this.manualOverrideSideBySide = true;
    await vscode.commands.executeCommand('toggle.diff.renderSideBySide');
  }

  async openInlineDiff(relativePath: string, jumpToLine?: number): Promise<void> {
    const pending = this.controller.getPending(relativePath);
    if (!pending) {
      return;
    }

    this.manualOverrideSideBySide = false;
    const autoInline = vscode.workspace
      .getConfiguration('inlineReview')
      .get<boolean>('autoInlineDiff', true);
    if (autoInline) {
      await this.activateGlobalInlineMode();
    }

    const leftUri = buildBaselineUri(relativePath);
    const rightUri =
      pending.kind === 'deleted'
        ? buildDeletedUri(relativePath)
        : vscode.Uri.file(pending.fsPath);
    const title = `${path.posix.basename(relativePath)} (Inline Review)`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
    });

    if (jumpToLine !== undefined) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === rightUri.toString()) {
        const line = Math.max(
          0,
          Math.min(jumpToLine, Math.max(0, editor.document.lineCount - 1))
        );
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      }
    }
  }

  async toggleInlineDiff(relativePath?: string): Promise<void> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (this.isOurDiffTab(activeTab) && activeTab) {
      const rel = this.getRelativePathFromTab(activeTab);
      const pending = rel ? this.controller.getPending(rel) : undefined;
      const activeEditor = vscode.window.activeTextEditor;
      const selection = activeEditor?.selection;
      const viewColumn = activeTab.group.viewColumn;

      if (rel && pending && pending.kind !== 'deleted') {
        await vscode.window.showTextDocument(vscode.Uri.file(pending.fsPath), {
          viewColumn,
          selection,
          preview: false,
        });
      } else if (rel) {
        const fsPath = path.join(this.controller.workspaceRoot, rel);
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(fsPath), {
            viewColumn,
            selection,
            preview: false,
          });
        } catch {
          // File doesn't exist (deleted)
        }
      }
      await vscode.window.tabGroups.close(activeTab);
      await this.syncInlineDiffSetting();
      return;
    }

    const target =
      relativePath ??
      this.getActiveRelativePath() ??
      this.controller.getAllPending()[0]?.relativePath;
    if (!target || !this.controller.hasPending(target)) {
      const first = this.controller.getAllPending()[0];
      if (!first) {
        void vscode.window.showInformationMessage('No pending inline reviews.');
        return;
      }
      await this.openInlineDiff(first.relativePath);
      return;
    }

    await this.openInlineDiff(target);
  }

  async returnToNormalTabIfResolved(relativePath: string): Promise<void> {
    const matchingTabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.isOurDiffTab(tab) && this.getRelativePathFromTab(tab) === relativePath) {
          matchingTabs.push(tab);
        }
      }
    }

    if (matchingTabs.length === 0) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const selection = activeEditor?.selection;
    const fsPath = path.join(this.controller.workspaceRoot, relativePath);

    let fileExists = true;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    } catch {
      fileExists = false;
    }

    for (const tab of matchingTabs) {
      const viewColumn = tab.group.viewColumn;
      const isFocused = tab.isActive && tab.group.isActive;
      if (isFocused && fileExists) {
        await vscode.window.showTextDocument(vscode.Uri.file(fsPath), {
          viewColumn,
          selection,
          preview: false,
        });
      }
      await vscode.window.tabGroups.close(tab);
    }

    await this.syncInlineDiffSetting();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
