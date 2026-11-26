import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { toPosixRelative } from '../baseline/noiseFilter.js';
import { computeHunks } from '../diff/diffEngine.js';
import {
  DELETED_SCHEME,
  parseRelativePathFromVirtualUri,
} from './baselineContentProvider.js';
import type { DiffViewManager } from './diffViewManager.js';

export class InlineReviewCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly controller: BaselineController,
    private readonly diffViewManager: DiffViewManager
  ) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme === DELETED_SCHEME) {
      const rel = parseRelativePathFromVirtualUri(document.uri);
      const pending = this.controller.getPending(rel);
      if (!pending || pending.kind !== 'deleted') {
        return [];
      }
      const range = new vscode.Range(0, 0, 0, 0);
      return [
        new vscode.CodeLens(range, {
          title: '🟩 Accept Deletion',
          command: 'inlineReview.acceptFile',
          arguments: [rel],
        }),
        new vscode.CodeLens(range, {
          title: '🟥 Restore File',
          command: 'inlineReview.rejectFile',
          arguments: [rel],
        }),
      ];
    }

    if (document.uri.scheme !== 'file') {
      return [];
    }

    const rel = toPosixRelative(this.controller.workspaceRoot, document.uri.fsPath);
    if (!rel) {
      return [];
    }

    const pending = this.controller.getPending(rel);
    if (!pending) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const inDiff = this.diffViewManager.isActiveTabOurDiff();

    if (pending.kind === 'created') {
      const topRange = new vscode.Range(0, 0, 0, 0);
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: '🟩 Accept New File',
          command: 'inlineReview.acceptFile',
          arguments: [rel],
        }),
        new vscode.CodeLens(topRange, {
          title: '🟥 Reject New File (Trash)',
          command: 'inlineReview.rejectFile',
          arguments: [rel],
        })
      );
      if (!inDiff) {
        lenses.push(
          new vscode.CodeLens(topRange, {
            title: '$(diff) Open Inline Diff',
            command: 'inlineReview.openInlineDiff',
            arguments: [rel, 0],
          })
        );
      }
      return lenses;
    }

    const hunks = computeHunks(pending.baselineContent ?? '', document.getText());
    if (hunks.length === 0) {
      return [];
    }

    const maxLine = Math.max(0, document.lineCount - 1);
    for (const h of hunks) {
      const targetLine = Math.min(h.newStart, maxLine);
      const range = new vscode.Range(targetLine, 0, targetLine, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '🟩 Accept',
          command: 'inlineReview.acceptHunk',
          arguments: [rel, h.index],
        }),
        new vscode.CodeLens(range, {
          title: '🟥 Reject',
          command: 'inlineReview.rejectHunk',
          arguments: [rel, h.index],
        })
      );

      if (!inDiff && h.oldCount > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(eye) -${h.oldCount} removed (Open Diff)`,
            command: 'inlineReview.openInlineDiff',
            arguments: [rel, targetLine],
          })
        );
      }
    }

    return lenses;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
