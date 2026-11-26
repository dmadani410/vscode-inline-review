import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { toPosixRelative } from '../baseline/noiseFilter.js';
import { computeHunks } from '../diff/diffEngine.js';
import type { DiffViewManager } from './diffViewManager.js';

export class DecorationManager implements vscode.Disposable {
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly deletionAnchorDecoration: vscode.TextEditorDecorationType;

  constructor(
    private readonly controller: BaselineController,
    private readonly diffViewManager: DiffViewManager
  ) {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(46, 160, 67, 0.16)',
      isWholeLine: true,
      overviewRulerColor: 'rgba(46, 160, 67, 0.75)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.deletionAnchorDecoration = vscode.window.createTextEditorDecorationType({
      borderWidth: '2px 0 0 0',
      borderStyle: 'solid',
      borderColor: 'rgba(248, 81, 73, 0.8)',
      isWholeLine: true,
      overviewRulerColor: 'rgba(248, 81, 73, 0.75)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  private isEditorInsideOurDiffTab(editor: vscode.TextEditor): boolean {
    if (!editor.viewColumn) {
      return this.diffViewManager.isActiveTabOurDiff();
    }
    const group = vscode.window.tabGroups.all.find(
      (g) => g.viewColumn === editor.viewColumn
    );
    return this.diffViewManager.isOurDiffTab(group?.activeTab);
  }

  updateAllVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor);
    }
  }

  updateEditor(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.deletionAnchorDecoration, []);
      return;
    }

    if (this.isEditorInsideOurDiffTab(editor)) {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.deletionAnchorDecoration, []);
      return;
    }

    const rel = toPosixRelative(
      this.controller.workspaceRoot,
      editor.document.uri.fsPath
    );
    if (!rel) {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.deletionAnchorDecoration, []);
      return;
    }

    const pending = this.controller.getPending(rel);
    if (!pending || pending.kind === 'deleted') {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.deletionAnchorDecoration, []);
      return;
    }

    const maxLine = Math.max(0, editor.document.lineCount - 1);
    const addedOptions: vscode.DecorationOptions[] = [];
    const deletionOptions: vscode.DecorationOptions[] = [];

    if (pending.kind === 'created') {
      for (let line = 0; line < editor.document.lineCount; line += 1) {
        addedOptions.push({
          range: new vscode.Range(line, 0, line, 0),
        });
      }
      editor.setDecorations(this.addedDecoration, addedOptions);
      editor.setDecorations(this.deletionAnchorDecoration, []);
      return;
    }

    const hunks = computeHunks(
      pending.baselineContent ?? '',
      editor.document.getText()
    );
    const langId = editor.document.languageId || 'plaintext';

    for (const h of hunks) {
      for (let offset = 0; offset < h.newCount; offset += 1) {
        const line = h.newStart + offset;
        if (line <= maxLine) {
          addedOptions.push({
            range: new vscode.Range(line, 0, line, 0),
          });
        }
      }

      if (h.oldCount > 0) {
        const anchorLine = Math.min(h.newStart, maxLine);
        const previewLines = h.oldLines.slice(0, 20);
        const truncated =
          h.oldLines.length > 20
            ? `\n... (${h.oldLines.length - 20} more removed lines)`
            : '';
        const hover = new vscode.MarkdownString();
        hover.isTrusted = true;
        const args = encodeURIComponent(JSON.stringify([rel, anchorLine]));
        hover.appendMarkdown(
          `**Inline Review** — ${h.oldCount} removed line(s) · [Open Inline Diff](command:inlineReview.openInlineDiff?${args})\n\n`
        );
        hover.appendCodeblock(previewLines.join('\n') + truncated, langId);

        deletionOptions.push({
          range: new vscode.Range(anchorLine, 0, anchorLine, 0),
          hoverMessage: hover,
        });
      }
    }

    editor.setDecorations(this.addedDecoration, addedOptions);
    editor.setDecorations(this.deletionAnchorDecoration, deletionOptions);
  }

  dispose(): void {
    this.addedDecoration.dispose();
    this.deletionAnchorDecoration.dispose();
  }
}
