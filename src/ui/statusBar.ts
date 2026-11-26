import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly controller: BaselineController) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'inlineReview.toggleInlineDiff';
  }

  async refresh(): Promise<void> {
    const pending = this.controller.getAllPending();
    if (pending.length === 0) {
      this.item.hide();
      return;
    }

    let totalHunks = 0;
    for (const item of pending) {
      if (item.kind === 'created' || item.kind === 'deleted') {
        totalHunks += 1;
        continue;
      }
      const hunks = await this.controller.getHunksForPending(item.relativePath);
      totalHunks += Math.max(1, hunks.length);
    }

    const fileWord = pending.length === 1 ? 'file' : 'files';
    const hunkWord = totalHunks === 1 ? 'hunk' : 'hunks';
    this.item.text = `$(git-compare) Inline Review: ${pending.length} ${fileWord} · ${totalHunks} ${hunkWord}`;
    this.item.tooltip =
      'Click to open/toggle Inline Diff (Alt+R) · Accept Hunk (Alt+Y) · Reject Hunk (Alt+N)';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
