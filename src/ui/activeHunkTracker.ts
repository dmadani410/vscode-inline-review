import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { toPosixRelative } from '../baseline/noiseFilter.js';
import {
  computeHunks,
  findExactHunkIndexForLine,
} from '../diff/diffEngine.js';
import {
  BASELINE_SCHEME,
  parseRelativePathFromVirtualUri,
} from './baselineContentProvider.js';

export interface ActiveHunkRef {
  relativePath: string;
  hunkIndex: number;
}

export interface ActiveHunkState {
  /** Single currently active pending hunk (selected by cursor/click or pointed by hover). */
  active: ActiveHunkRef | null;
}

function refsEqual(a: ActiveHunkRef | null, b: ActiveHunkRef | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.relativePath === b.relativePath && a.hunkIndex === b.hunkIndex;
}

export class ActiveHunkTracker
  implements vscode.HoverProvider, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<ActiveHunkState>();
  readonly onDidChange = this._onDidChange.event;

  private active: ActiveHunkRef | null = null;

  constructor(private readonly controller: BaselineController) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        void this.syncFromEditorSelection(e.textEditor);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          this.setActive(null);
          return;
        }
        const rel = this.resolveDocContext(editor.document)?.relativePath ?? null;
        if (this.active && this.active.relativePath !== rel) {
          this.setActive(null);
        }
        void this.syncFromEditorSelection(editor);
      })
    );
  }

  getState(): ActiveHunkState {
    return {
      active: this.active ? { ...this.active } : null,
    };
  }

  setSelected(ref: ActiveHunkRef | null): void {
    this.setActive(ref);
  }

  private setActive(ref: ActiveHunkRef | null): void {
    if (refsEqual(this.active, ref)) {
      return;
    }
    this.active = ref ? { ...ref } : null;
    this._onDidChange.fire(this.getState());
  }

  clearForFile(relativePath: string): void {
    if (this.active?.relativePath === relativePath) {
      this.active = null;
      this._onDidChange.fire(this.getState());
    }
  }

  private resolveDocContext(
    document: vscode.TextDocument
  ): { relativePath: string; side: 'new' | 'old' } | null {
    if (document.uri.scheme === 'file') {
      const rel = toPosixRelative(
        this.controller.workspaceRoot,
        document.uri.fsPath
      );
      if (!rel || !this.controller.hasPending(rel)) {
        return null;
      }
      return { relativePath: rel, side: 'new' };
    }
    if (document.uri.scheme === BASELINE_SCHEME) {
      const rel = parseRelativePathFromVirtualUri(document.uri);
      if (!rel || !this.controller.hasPending(rel)) {
        return null;
      }
      return { relativePath: rel, side: 'old' };
    }
    return null;
  }

  private async resolveHunkAtLine(
    document: vscode.TextDocument,
    line: number
  ): Promise<ActiveHunkRef | null> {
    const ctx = this.resolveDocContext(document);
    if (!ctx) {
      return null;
    }

    const pending = this.controller.getPending(ctx.relativePath);
    if (!pending) {
      return null;
    }

    if (pending.kind === 'created' || pending.kind === 'deleted') {
      return { relativePath: ctx.relativePath, hunkIndex: 0 };
    }

    const currentText =
      ctx.side === 'new'
        ? document.getText()
        : await this.controller.readLiveOrDiskContent(
            pending.relativePath,
            pending.fsPath
          );
    if (currentText === null) {
      return null;
    }

    const hunks = computeHunks(pending.baselineContent ?? '', currentText);
    const idx = findExactHunkIndexForLine(hunks, line, ctx.side);
    if (idx === null) {
      return null;
    }

    return { relativePath: ctx.relativePath, hunkIndex: idx };
  }

  async syncFromEditorSelection(editor: vscode.TextEditor): Promise<void> {
    const ctx = this.resolveDocContext(editor.document);
    if (!ctx) {
      return;
    }
    const ref = await this.resolveHunkAtLine(
      editor.document,
      editor.selection.active.line
    );
    this.setSelected(ref);
  }

  /**
   * Highlights the pointed hunk in the sidebar and displays a minimal inline
   * green/red Accept & Reject action bar without any redundant "Hunk #X" text.
   */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const ctx = this.resolveDocContext(document);
    if (!ctx) {
      return undefined;
    }
    const ref = await this.resolveHunkAtLine(document, position.line);
    if (ref) {
      this.setActive(ref);
    }
    if (!ref) {
      return undefined;
    }

    const pending = this.controller.getPending(ref.relativePath);
    if (!pending) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.isTrusted = true;

    let acceptCmd: string;
    let rejectCmd: string;
    let acceptLabel: string;
    let rejectLabel: string;

    if (pending.kind === 'created') {
      const args = encodeURIComponent(JSON.stringify([ref.relativePath]));
      acceptCmd = `command:inlineReview.acceptFile?${args}`;
      rejectCmd = `command:inlineReview.rejectFile?${args}`;
      acceptLabel = '✓ Accept File';
      rejectLabel = '✕ Reject File';
    } else if (pending.kind === 'deleted') {
      const args = encodeURIComponent(JSON.stringify([ref.relativePath]));
      acceptCmd = `command:inlineReview.acceptFile?${args}`;
      rejectCmd = `command:inlineReview.rejectFile?${args}`;
      acceptLabel = '✓ Accept Deletion';
      rejectLabel = '✕ Restore File';
    } else {
      const args = encodeURIComponent(
        JSON.stringify([ref.relativePath, ref.hunkIndex])
      );
      acceptCmd = `command:inlineReview.acceptHunk?${args}`;
      rejectCmd = `command:inlineReview.rejectHunk?${args}`;
      acceptLabel = '✓ Accept';
      rejectLabel = '✕ Reject';
    }

    md.appendMarkdown(
      `<a href="${acceptCmd}"><span style="color:#ffffff;background-color:#238636;">&nbsp;&nbsp;${acceptLabel}&nbsp;&nbsp;</span></a>` +
        `&nbsp;&nbsp;` +
        `<a href="${rejectCmd}"><span style="color:#ffffff;background-color:#da3633;">&nbsp;&nbsp;${rejectLabel}&nbsp;&nbsp;</span></a>`
    );

    return new vscode.Hover(md);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}
