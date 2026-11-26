import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { toPosixRelative } from '../baseline/noiseFilter.js';
import { buildBaselineUri } from './baselineContentProvider.js';

export class QuickDiffManager implements vscode.Disposable {
  private readonly sourceControl: vscode.SourceControl;

  constructor(
    workspaceFolder: vscode.WorkspaceFolder,
    private readonly controller: BaselineController
  ) {
    this.sourceControl = vscode.scm.createSourceControl(
      'inline-review',
      'Inline Review',
      workspaceFolder.uri
    );
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri: vscode.Uri): vscode.Uri | undefined => {
        if (uri.scheme !== 'file') {
          return undefined;
        }
        const rel = toPosixRelative(this.controller.workspaceRoot, uri.fsPath);
        if (!rel) {
          return undefined;
        }
        const pending = this.controller.getPending(rel);
        if (!pending || pending.kind === 'created') {
          return undefined;
        }
        return buildBaselineUri(rel);
      },
    };
  }

  refresh(): void {
    this.sourceControl.count = this.controller.getAllPending().length;
  }

  dispose(): void {
    this.sourceControl.dispose();
  }
}
