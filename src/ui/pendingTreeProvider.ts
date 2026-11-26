import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BaselineController } from '../baseline/baselineController.js';
import { computeHunks, computeStats } from '../diff/diffEngine.js';
import type { DiffHunk, FileStats, PendingFileReview } from '../types.js';

export interface PendingFileNode {
  nodeType: 'file';
  review: PendingFileReview;
  hunks: DiffHunk[];
  stats: FileStats;
}

export interface PendingHunkNode {
  nodeType: 'hunk';
  relativePath: string;
  hunk: DiffHunk;
}

export type PendingTreeItem = PendingFileNode | PendingHunkNode;

export class PendingTreeProvider
  implements vscode.TreeDataProvider<PendingTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    PendingTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private treeView: vscode.TreeView<PendingTreeItem> | undefined;

  constructor(private readonly controller: BaselineController) {}

  attachTreeView(treeView: vscode.TreeView<PendingTreeItem>): void {
    this.treeView = treeView;
    this.updateBadge();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
    this.updateBadge();
  }

  private updateBadge(): void {
    if (!this.treeView) {
      return;
    }
    const count = this.controller.getAllPending().length;
    this.treeView.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} pending file review(s)`,
          }
        : undefined;
  }

  getTreeItem(element: PendingTreeItem): vscode.TreeItem {
    if (element.nodeType === 'file') {
      const { review, hunks, stats } = element;
      const fileName = path.posix.basename(review.relativePath);
      const dirName = path.posix.dirname(review.relativePath);
      const collapsible =
        review.kind === 'modified' && hunks.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None;

      const item = new vscode.TreeItem(fileName, collapsible);
      item.id = `file:${review.relativePath}`;
      item.contextValue = 'file';
      item.resourceUri = vscode.Uri.file(review.fsPath);
      item.tooltip = review.relativePath;

      const dirLabel = dirName === '.' ? '' : `${dirName} · `;
      if (review.kind === 'created') {
        item.description = `${dirLabel}Created`;
        item.iconPath = new vscode.ThemeIcon('diff-added');
      } else if (review.kind === 'deleted') {
        item.description = `${dirLabel}Deleted`;
        item.iconPath = new vscode.ThemeIcon('diff-removed');
      } else {
        item.description = `${dirLabel}+${stats.additions} -${stats.deletions} · ${stats.hunkCount} hunk(s)`;
        item.iconPath = new vscode.ThemeIcon('diff-modified');
      }

      item.command = {
        command: 'inlineReview.openInlineDiff',
        title: 'Open Inline Diff',
        arguments: [review.relativePath, hunks[0]?.newStart ?? 0],
      };
      return item;
    }

    const { relativePath, hunk } = element;
    const item = new vscode.TreeItem(
      `Hunk #${hunk.index + 1} (${hunk.header})`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `hunk:${relativePath}:${hunk.index}`;
    item.contextValue = 'hunk';
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.tooltip = `Line ${hunk.newStart + 1}: +${hunk.newCount} -${hunk.oldCount}`;
    item.command = {
      command: 'inlineReview.openInlineDiff',
      title: 'Open Inline Diff at Hunk',
      arguments: [relativePath, hunk.newStart],
    };
    return item;
  }

  async getChildren(element?: PendingTreeItem): Promise<PendingTreeItem[]> {
    if (element) {
      if (element.nodeType === 'file' && element.review.kind === 'modified') {
        return element.hunks.map((hunk) => ({
          nodeType: 'hunk' as const,
          relativePath: element.review.relativePath,
          hunk,
        }));
      }
      return [];
    }

    const all = this.controller.getAllPending();
    const nodes: PendingFileNode[] = [];
    for (const review of all) {
      if (review.kind === 'deleted') {
        const hunks = computeHunks(review.baselineContent ?? '', '');
        nodes.push({
          nodeType: 'file',
          review,
          hunks,
          stats: computeStats(hunks),
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
      nodes.push({
        nodeType: 'file',
        review,
        hunks,
        stats: computeStats(hunks),
      });
    }
    return nodes;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
