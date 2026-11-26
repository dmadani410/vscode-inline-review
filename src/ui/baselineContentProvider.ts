import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { normalizePosixPath } from '../baseline/noiseFilter.js';

export const BASELINE_SCHEME = 'inline-review-baseline';
export const DELETED_SCHEME = 'inline-review-deleted';

export function buildBaselineUri(relativePath: string): vscode.Uri {
  const norm = normalizePosixPath(relativePath);
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: `/${norm}`,
  });
}

export function buildDeletedUri(relativePath: string): vscode.Uri {
  const norm = normalizePosixPath(relativePath);
  return vscode.Uri.from({
    scheme: DELETED_SCHEME,
    path: `/${norm}`,
  });
}

export function parseRelativePathFromVirtualUri(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, '');
}

export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly controller: BaselineController) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme === DELETED_SCHEME) {
      return '';
    }
    const rel = parseRelativePathFromVirtualUri(uri);
    const pending = this.controller.getPending(rel);
    return pending?.baselineContent ?? '';
  }

  refresh(relativePath?: string): void {
    if (relativePath) {
      this._onDidChange.fire(buildBaselineUri(relativePath));
      return;
    }
    for (const item of this.controller.getAllPending()) {
      this._onDidChange.fire(buildBaselineUri(item.relativePath));
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
