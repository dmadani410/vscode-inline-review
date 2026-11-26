import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applyHunkToBaseline,
  computeHunks,
  computeMinimalTextEdit,
  normalizeNewlines,
  revertHunkInCurrent,
} from '../diff/diffEngine.js';
import { planUndoAction, UndoStack } from '../diff/undoStack.js';
import type { DiffHunk, PendingFileReview } from '../types.js';
import { GitService } from './gitService.js';
import {
  isBinaryBuffer,
  isOversized,
  isPathIgnoredByDefault,
  normalizePosixPath,
  toPosixRelative,
} from './noiseFilter.js';
import { ReviewStore } from './reviewStore.js';

type WatchEventKind = 'created' | 'changed' | 'deleted';

interface QueuedFsEvent {
  relativePath: string;
  fsPath: string;
  kind: WatchEventKind;
}

export interface ReviewActionResult {
  ok: boolean;
  resolvedFile?: boolean;
  message?: string;
}

export class BaselineController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidFileResolved = new vscode.EventEmitter<string>();
  readonly onDidFileResolved = this._onDidFileResolved.event;

  private readonly internalSuppressed = new Map<string, number>();
  private readonly userSavingSuppressed = new Map<string, number>();
  private readonly userCreatedSuppressed = new Map<string, number>();
  private readonly userDeletedSuppressed = new Map<string, number>();

  private readonly eventQueue = new Map<string, QueuedFsEvent>();
  private flushTimer: NodeJS.Timeout | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private docChangeTimer: NodeJS.Timeout | undefined;
  private gitTransitionUntil = 0;
  private isGit = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    public readonly workspaceRoot: string,
    private readonly store: ReviewStore,
    private readonly undoStack: UndoStack,
    private readonly gitService: GitService
  ) {}

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration('inlineReview');
    return {
      enabled: cfg.get<boolean>('enabled', true),
      autoSaveOnReject: cfg.get<boolean>('autoSaveOnReject', true),
      excludePatterns: cfg.get<string[]>('excludePatterns', []),
      maxFileSizeKB: cfg.get<number>('maxFileSizeKB', 2048),
      maxBurstFiles: cfg.get<number>('maxBurstFiles', 50),
      persistState: cfg.get<boolean>('persistState', true),
    };
  }

  private getStateUri(): vscode.Uri {
    const baseDir = this.context.storageUri ?? this.context.globalStorageUri;
    return vscode.Uri.joinPath(baseDir, 'inline-review-state.json');
  }

  async initialize(): Promise<void> {
    this.isGit = await this.gitService.isGitRepo();
    await this.loadPersistedState();
    await this.snapshotInitialBaselines();
    this.registerWatchers();
    this._onDidChange.fire(undefined);
  }

  private async loadPersistedState(): Promise<void> {
    if (!this.getConfig().persistState) {
      return;
    }
    try {
      const raw = await vscode.workspace.fs.readFile(this.getStateUri());
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
      this.store.hydrate(parsed);
      await this.pruneResolvedPending();
    } catch {
      // No saved state yet or unreadable
    }
  }

  private async pruneResolvedPending(): Promise<void> {
    for (const item of this.store.getAllPending()) {
      const current = await this.readLiveOrDiskContent(item.relativePath, item.fsPath);
      if (item.kind === 'deleted') {
        if (current !== null) {
          if (
            item.baselineContent !== null &&
            normalizeNewlines(item.baselineContent) === normalizeNewlines(current)
          ) {
            this.store.removePending(item.relativePath);
          } else {
            this.store.upsertPending({ ...item, kind: 'modified' });
          }
        }
        continue;
      }

      if (current === null) {
        if (item.kind === 'created') {
          this.store.removePending(item.relativePath);
        } else {
          this.store.upsertPending({ ...item, kind: 'deleted' });
        }
        continue;
      }

      if (
        item.baselineContent !== null &&
        normalizeNewlines(item.baselineContent) === normalizeNewlines(current)
      ) {
        this.store.removePending(item.relativePath);
        this.store.setCleanBaseline(item.relativePath, item.baselineContent);
      }
    }
  }

  private async snapshotInitialBaselines(): Promise<void> {
    const cfg = this.getConfig();

    if (this.isGit) {
      const dirty = await this.gitService.getDirtyFiles();
      for (const entry of dirty) {
        if (this.store.hasPending(entry.relativePath)) {
          continue;
        }
        if (isPathIgnoredByDefault(entry.relativePath, cfg.excludePatterns)) {
          continue;
        }
        const fsPath = path.join(this.workspaceRoot, entry.relativePath);
        const disk = await this.readDiskTextIfTrackable(fsPath, cfg.maxFileSizeKB);
        if (disk !== null) {
          this.store.setCleanBaseline(entry.relativePath, disk);
        }
      }
    }

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') {
        continue;
      }
      const rel = toPosixRelative(this.workspaceRoot, doc.uri.fsPath);
      if (!rel || this.store.hasPending(rel) || this.store.getCleanBaseline(rel) !== undefined) {
        continue;
      }
      if (!isPathIgnoredByDefault(rel, cfg.excludePatterns)) {
        this.store.setCleanBaseline(rel, doc.getText());
      }
    }
  }

  private registerWatchers(): void {
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, '**/*')
    );

    this.disposables.push(
      fileWatcher,
      fileWatcher.onDidCreate((uri) => this.enqueueWatchEvent(uri, 'created')),
      fileWatcher.onDidChange((uri) => this.enqueueWatchEvent(uri, 'changed')),
      fileWatcher.onDidDelete((uri) => this.enqueueWatchEvent(uri, 'deleted'))
    );

    if (this.isGit) {
      const gitWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          this.workspaceRoot,
          '.git/{HEAD,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD}'
        )
      );
      this.disposables.push(
        gitWatcher,
        gitWatcher.onDidChange(() => this.onGitTransition()),
        gitWatcher.onDidCreate(() => this.onGitTransition()),
        gitWatcher.onDidDelete(() => this.onGitTransition())
      );
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') {
          return;
        }
        const rel = toPosixRelative(this.workspaceRoot, doc.uri.fsPath);
        if (!rel || this.store.hasPending(rel) || this.store.getCleanBaseline(rel) !== undefined) {
          return;
        }
        if (!isPathIgnoredByDefault(rel, this.getConfig().excludePatterns)) {
          this.store.setCleanBaseline(rel, doc.getText());
        }
      }),

      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') {
          return;
        }
        const rel = toPosixRelative(this.workspaceRoot, e.document.uri.fsPath);
        if (rel) {
          this.suppress(this.userSavingSuppressed, rel, 2500);
        }
      }),

      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.uri.scheme !== 'file') {
          return;
        }
        const rel = toPosixRelative(this.workspaceRoot, doc.uri.fsPath);
        if (!rel) {
          return;
        }
        this.suppress(this.userSavingSuppressed, rel, 1200);

        const pending = this.store.getPending(rel);
        if (!pending) {
          if (!isPathIgnoredByDefault(rel, this.getConfig().excludePatterns)) {
            this.store.setCleanBaseline(rel, doc.getText());
            this.schedulePersist();
          }
          return;
        }

        if (
          pending.baselineContent !== null &&
          normalizeNewlines(pending.baselineContent) === normalizeNewlines(doc.getText())
        ) {
          this.store.removePending(rel);
          this.store.setCleanBaseline(rel, pending.baselineContent);
          this.schedulePersist();
          this._onDidFileResolved.fire(rel);
          this._onDidChange.fire(rel);
        }
      }),

      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
          return;
        }
        const rel = toPosixRelative(this.workspaceRoot, e.document.uri.fsPath);
        if (!rel || !this.store.hasPending(rel)) {
          return;
        }
        if (this.docChangeTimer) {
          clearTimeout(this.docChangeTimer);
        }
        this.docChangeTimer = setTimeout(() => {
          this._onDidChange.fire(rel);
        }, 120);
      }),

      vscode.workspace.onDidCreateFiles((e) => {
        for (const uri of e.files) {
          const rel = toPosixRelative(this.workspaceRoot, uri.fsPath);
          if (rel) {
            this.suppress(this.userCreatedSuppressed, rel, 2000);
          }
        }
      }),

      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          const rel = toPosixRelative(this.workspaceRoot, uri.fsPath);
          if (rel) {
            this.suppress(this.userDeletedSuppressed, rel, 2000);
          }
        }
      })
    );
  }

  private onGitTransition(): void {
    this.gitTransitionUntil = Date.now() + 2500;
    this.eventQueue.clear();
    void this.snapshotInitialBaselines();
  }

  private suppress(map: Map<string, number>, relativePath: string, ms: number): void {
    map.set(relativePath, Date.now() + ms);
  }

  private isSuppressed(relativePath: string, kind: WatchEventKind): boolean {
    const now = Date.now();
    const check = (map: Map<string, number>) => {
      const exp = map.get(relativePath);
      if (exp === undefined) {
        return false;
      }
      if (exp < now) {
        map.delete(relativePath);
        return false;
      }
      return true;
    };

    if (check(this.internalSuppressed) || check(this.userSavingSuppressed)) {
      return true;
    }
    if (kind === 'created' && check(this.userCreatedSuppressed)) {
      return true;
    }
    if (kind === 'deleted' && check(this.userDeletedSuppressed)) {
      return true;
    }
    return false;
  }

  private enqueueWatchEvent(uri: vscode.Uri, kind: WatchEventKind): void {
    if (uri.scheme !== 'file' || !this.getConfig().enabled) {
      return;
    }
    if (Date.now() < this.gitTransitionUntil) {
      return;
    }
    const rel = toPosixRelative(this.workspaceRoot, uri.fsPath);
    if (!rel) {
      return;
    }
    if (this.isSuppressed(rel, kind)) {
      return;
    }

    const existing = this.eventQueue.get(rel);
    if (existing) {
      // Keep 'created' if file was created then immediately modified in same burst
      if (!(existing.kind === 'created' && kind === 'changed')) {
        existing.kind = kind;
      }
    } else {
      this.eventQueue.set(rel, {
        relativePath: rel,
        fsPath: uri.fsPath,
        kind,
      });
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      void this.flushWatchQueue();
    }, 300);
  }

  private async flushWatchQueue(): Promise<void> {
    if (this.eventQueue.size === 0) {
      return;
    }
    if (Date.now() < this.gitTransitionUntil) {
      this.eventQueue.clear();
      return;
    }

    const batch = Array.from(this.eventQueue.values());
    this.eventQueue.clear();

    const cfg = this.getConfig();
    const filtered = batch.filter(
      (ev) => !isPathIgnoredByDefault(ev.relativePath, cfg.excludePatterns)
    );
    if (filtered.length === 0) {
      return;
    }

    let finalBatch = filtered;
    if (this.isGit) {
      const ignoredSet = await this.gitService.checkIgnored(
        filtered.map((f) => f.relativePath)
      );
      finalBatch = filtered.filter((f) => !ignoredSet.has(f.relativePath));
    }

    if (finalBatch.length === 0) {
      return;
    }

    if (finalBatch.length > cfg.maxBurstFiles) {
      const choice = await vscode.window.showWarningMessage(
        `Inline Review detected ${finalBatch.length} changed files in a single burst (threshold: ${cfg.maxBurstFiles}). Import them into Pending Reviews?`,
        'Import Anyway',
        'Ignore Burst'
      );
      if (choice !== 'Import Anyway') {
        return;
      }
    }

    await this.processEventBatch(finalBatch, cfg.maxFileSizeKB);
  }

  private async processEventBatch(
    events: QueuedFsEvent[],
    maxFileSizeKB: number
  ): Promise<void> {
    let changed = false;
    const resolvedPaths: string[] = [];

    for (const ev of events) {
      if (this.isSuppressed(ev.relativePath, ev.kind)) {
        continue;
      }

      if (ev.kind === 'deleted') {
        const fallback = this.isGit
          ? await this.gitService.getIndexOrHeadContent(ev.relativePath)
          : null;
        const outcome = this.store.recordExternalDeletion(
          ev.relativePath,
          ev.fsPath,
          fallback
        );
        if (outcome === 'resolved') {
          resolvedPaths.push(ev.relativePath);
          changed = true;
        } else if (outcome !== 'noop') {
          changed = true;
        }
        continue;
      }

      const content = await this.readDiskTextIfTrackable(ev.fsPath, maxFileSizeKB);
      if (content === null) {
        continue;
      }

      if (ev.kind === 'created') {
        const outcome = this.store.recordExternalCreation(
          ev.relativePath,
          ev.fsPath,
          content
        );
        if (outcome === 'resolved') {
          resolvedPaths.push(ev.relativePath);
          changed = true;
        } else if (outcome !== 'noop') {
          changed = true;
        }
        continue;
      }

      const fallback = this.isGit
        ? await this.gitService.getIndexOrHeadContent(ev.relativePath)
        : null;
      const outcome = this.store.recordExternalModification(
        ev.relativePath,
        ev.fsPath,
        content,
        fallback
      );
      if (outcome === 'resolved') {
        resolvedPaths.push(ev.relativePath);
        changed = true;
      } else if (outcome !== 'noop') {
        changed = true;
      }
    }

    if (changed) {
      this.schedulePersist();
      for (const rel of resolvedPaths) {
        this._onDidFileResolved.fire(rel);
      }
      this._onDidChange.fire(undefined);
    }
  }

  private async readDiskTextIfTrackable(
    fsPath: string,
    maxFileSizeKB: number
  ): Promise<string | null> {
    try {
      const stat = await fs.stat(fsPath);
      if (!stat.isFile() || isOversized(stat.size, maxFileSizeKB)) {
        return null;
      }
      const buf = await fs.readFile(fsPath);
      if (isBinaryBuffer(buf)) {
        return null;
      }
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  private findOpenDocument(fsPath: string): vscode.TextDocument | undefined {
    const target =
      process.platform === 'win32'
        ? path.resolve(fsPath).toLowerCase()
        : path.resolve(fsPath);
    return vscode.workspace.textDocuments.find((doc) => {
      if (doc.uri.scheme !== 'file') {
        return false;
      }
      const p =
        process.platform === 'win32'
          ? path.resolve(doc.uri.fsPath).toLowerCase()
          : path.resolve(doc.uri.fsPath);
      return p === target;
    });
  }

  async readLiveOrDiskContent(
    _relativePath: string,
    fsPath: string
  ): Promise<string | null> {
    const openDoc = this.findOpenDocument(fsPath);
    if (openDoc) {
      return openDoc.getText();
    }
    try {
      const buf = await fs.readFile(fsPath);
      if (isBinaryBuffer(buf)) {
        return null;
      }
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  getAllPending(): PendingFileReview[] {
    return this.store.getAllPending();
  }

  getPending(relativePath: string): PendingFileReview | undefined {
    return this.store.getPending(relativePath);
  }

  hasPending(relativePath: string): boolean {
    return this.store.hasPending(relativePath);
  }

  canUndo(): boolean {
    return this.undoStack.canUndo();
  }

  async getHunksForPending(relativePath: string): Promise<DiffHunk[]> {
    const pending = this.store.getPending(relativePath);
    if (!pending) {
      return [];
    }
    if (pending.kind === 'deleted') {
      return computeHunks(pending.baselineContent ?? '', '');
    }
    const current = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
    if (current === null) {
      return [];
    }
    return computeHunks(pending.baselineContent ?? '', current);
  }

  async acceptHunk(relativePath: string, hunkIndex: number): Promise<ReviewActionResult> {
    const pending = this.store.getPending(relativePath);
    if (!pending) {
      return { ok: false, message: 'No pending review for this file.' };
    }

    if (pending.kind === 'created' || pending.kind === 'deleted') {
      return this.acceptFile(relativePath);
    }

    const current = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
    if (current === null) {
      return { ok: false, message: 'File could not be read.' };
    }

    const baseline = pending.baselineContent ?? '';
    const hunks = computeHunks(baseline, current);
    if (hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, message: 'Hunk is no longer present.' };
    }

    const prevPendingClone: PendingFileReview = { ...pending };
    const prevClean = this.store.getCleanBaseline(relativePath) ?? null;

    const { nextBaseline, remainingHunks } = applyHunkToBaseline(
      baseline,
      current,
      hunkIndex
    );

    this.undoStack.push({
      type: 'accept',
      relativePath,
      fsPath: pending.fsPath,
      description: `Accept change at L${hunks[hunkIndex].newStart + 1} in ${relativePath}`,
      previousPending: prevPendingClone,
      previousCleanBaseline: prevClean,
    });

    const resolved =
      remainingHunks.length === 0 ||
      normalizeNewlines(nextBaseline) === normalizeNewlines(current);

    if (resolved) {
      this.store.removePending(relativePath);
      this.store.setCleanBaseline(relativePath, current);
      await this.persistNow();
      this._onDidFileResolved.fire(relativePath);
      this._onDidChange.fire(relativePath);
      return { ok: true, resolvedFile: true };
    }

    this.store.upsertPending({
      ...pending,
      baselineContent: nextBaseline,
      updatedAt: Date.now(),
    });
    await this.persistNow();
    this._onDidChange.fire(relativePath);
    return { ok: true, resolvedFile: false };
  }

  async rejectHunk(relativePath: string, hunkIndex: number): Promise<ReviewActionResult> {
    const pending = this.store.getPending(relativePath);
    if (!pending) {
      return { ok: false, message: 'No pending review for this file.' };
    }

    if (pending.kind === 'created' || pending.kind === 'deleted') {
      return this.rejectFile(relativePath);
    }

    const current = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
    if (current === null) {
      return { ok: false, message: 'File could not be read.' };
    }

    const baseline = pending.baselineContent ?? '';
    const hunks = computeHunks(baseline, current);
    if (hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, message: 'Hunk is no longer present.' };
    }

    const prevPendingClone: PendingFileReview = { ...pending };
    const prevClean = this.store.getCleanBaseline(relativePath) ?? null;

    const { nextCurrent, remainingHunks } = revertHunkInCurrent(
      baseline,
      current,
      hunkIndex
    );

    const applied = await this.applyTextUpdate(
      relativePath,
      pending.fsPath,
      nextCurrent,
      this.getConfig().autoSaveOnReject
    );
    if (!applied) {
      return { ok: false, message: 'Failed to update file on reject.' };
    }

    this.undoStack.push({
      type: 'reject',
      relativePath,
      fsPath: pending.fsPath,
      description: `Reject change at L${hunks[hunkIndex].newStart + 1} in ${relativePath}`,
      previousPending: prevPendingClone,
      previousCleanBaseline: prevClean,
      contentBeforeReject: current,
      contentAfterReject: nextCurrent,
    });

    const resolved =
      remainingHunks.length === 0 ||
      normalizeNewlines(nextCurrent) === normalizeNewlines(baseline);

    if (resolved) {
      this.store.removePending(relativePath);
      this.store.setCleanBaseline(relativePath, nextCurrent);
      await this.persistNow();
      this._onDidFileResolved.fire(relativePath);
      this._onDidChange.fire(relativePath);
      return { ok: true, resolvedFile: true };
    }

    this.store.upsertPending({
      ...pending,
      updatedAt: Date.now(),
    });
    await this.persistNow();
    this._onDidChange.fire(relativePath);
    return { ok: true, resolvedFile: false };
  }

  async acceptFile(relativePath: string): Promise<ReviewActionResult> {
    const pending = this.store.getPending(relativePath);
    if (!pending) {
      return { ok: false, message: 'No pending review for this file.' };
    }

    const prevPendingClone: PendingFileReview = { ...pending };
    const prevClean = this.store.getCleanBaseline(relativePath) ?? null;

    if (pending.kind === 'deleted') {
      this.store.deleteCleanBaseline(relativePath);
    } else {
      const current = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
      if (current !== null) {
        this.store.setCleanBaseline(relativePath, current);
      }
    }

    this.store.removePending(relativePath);
    this.undoStack.push({
      type: 'accept',
      relativePath,
      fsPath: pending.fsPath,
      description: `Accept file ${relativePath}`,
      previousPending: prevPendingClone,
      previousCleanBaseline: prevClean,
    });

    await this.persistNow();
    this._onDidFileResolved.fire(relativePath);
    this._onDidChange.fire(relativePath);
    return { ok: true, resolvedFile: true };
  }

  async rejectFile(relativePath: string): Promise<ReviewActionResult> {
    const pending = this.store.getPending(relativePath);
    if (!pending) {
      return { ok: false, message: 'No pending review for this file.' };
    }

    const prevPendingClone: PendingFileReview = { ...pending };
    const prevClean = this.store.getCleanBaseline(relativePath) ?? null;

    if (pending.kind === 'created') {
      const before = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
      this.suppress(this.internalSuppressed, relativePath, 2500);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(pending.fsPath), {
          useTrash: true,
        });
      } catch {
        return { ok: false, message: `Failed to move ${relativePath} to Trash.` };
      }

      this.store.removePending(relativePath);
      this.store.deleteCleanBaseline(relativePath);
      this.undoStack.push({
        type: 'reject',
        relativePath,
        fsPath: pending.fsPath,
        description: `Reject created file ${relativePath}`,
        previousPending: prevPendingClone,
        previousCleanBaseline: prevClean,
        contentBeforeReject: before,
        contentAfterReject: null,
      });

      await this.persistNow();
      this._onDidFileResolved.fire(relativePath);
      this._onDidChange.fire(relativePath);
      return { ok: true, resolvedFile: true };
    }

    const baseline = pending.baselineContent ?? '';

    if (pending.kind === 'deleted') {
      this.suppress(this.internalSuppressed, relativePath, 2500);
      const uri = vscode.Uri.file(pending.fsPath);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(pending.fsPath))
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(baseline, 'utf8'));

      this.store.removePending(relativePath);
      this.store.setCleanBaseline(relativePath, baseline);
      this.undoStack.push({
        type: 'reject',
        relativePath,
        fsPath: pending.fsPath,
        description: `Restore deleted file ${relativePath}`,
        previousPending: prevPendingClone,
        previousCleanBaseline: prevClean,
        contentBeforeReject: null,
        contentAfterReject: baseline,
      });

      await this.persistNow();
      this._onDidFileResolved.fire(relativePath);
      this._onDidChange.fire(relativePath);
      return { ok: true, resolvedFile: true };
    }

    // Modified file
    const before = await this.readLiveOrDiskContent(pending.relativePath, pending.fsPath);
    if (before === null) {
      return { ok: false, message: 'File could not be read.' };
    }

    const applied = await this.applyTextUpdate(
      relativePath,
      pending.fsPath,
      baseline,
      this.getConfig().autoSaveOnReject
    );
    if (!applied) {
      return { ok: false, message: `Failed to revert ${relativePath}.` };
    }

    this.store.removePending(relativePath);
    this.store.setCleanBaseline(relativePath, baseline);
    this.undoStack.push({
      type: 'reject',
      relativePath,
      fsPath: pending.fsPath,
      description: `Reject file ${relativePath}`,
      previousPending: prevPendingClone,
      previousCleanBaseline: prevClean,
      contentBeforeReject: before,
      contentAfterReject: baseline,
    });

    await this.persistNow();
    this._onDidFileResolved.fire(relativePath);
    this._onDidChange.fire(relativePath);
    return { ok: true, resolvedFile: true };
  }

  async acceptAll(): Promise<void> {
    const all = this.store.getAllPending();
    for (const item of all) {
      await this.acceptFile(item.relativePath);
    }
  }

  async rejectAll(): Promise<void> {
    const all = this.store.getAllPending();
    if (all.length === 0) {
      return;
    }
    const hasDestructive = all.some(
      (f) => f.kind === 'created' || f.kind === 'deleted'
    );
    if (all.length > 1 || hasDestructive) {
      const answer = await vscode.window.showWarningMessage(
        `Reject all changes across ${all.length} pending file(s)? Newly created files will be moved to Trash.`,
        { modal: true },
        'Reject All'
      );
      if (answer !== 'Reject All') {
        return;
      }
    }

    for (const item of all) {
      await this.rejectFile(item.relativePath);
    }
  }

  async undoLastAction(): Promise<ReviewActionResult> {
    const entry = this.undoStack.pop();
    if (!entry) {
      return { ok: false, message: 'Nothing to undo.' };
    }

    const currentDisk = await this.readLiveOrDiskContent(entry.relativePath, entry.fsPath);
    const plan = planUndoAction(entry, currentDisk);

    if (!plan.ok) {
      // Re-push entry so user retains history and inform them without overwriting
      this.undoStack.push(entry);
      void vscode.window.showWarningMessage(
        `Cannot safely undo "${entry.description}": ${plan.reason}`
      );
      return { ok: false, message: plan.reason };
    }

    if (plan.fileWrite === 'write' && plan.nextContent !== undefined) {
      const ok = await this.applyTextUpdate(
        entry.relativePath,
        entry.fsPath,
        plan.nextContent,
        this.getConfig().autoSaveOnReject
      );
      if (!ok) {
        this.undoStack.push(entry);
        return { ok: false, message: 'Failed to write file during undo.' };
      }
    } else if (plan.fileWrite === 'create' && plan.nextContent !== undefined) {
      this.suppress(this.internalSuppressed, entry.relativePath, 2500);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(entry.fsPath))
      );
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(entry.fsPath),
        Buffer.from(plan.nextContent, 'utf8')
      );
    } else if (plan.fileWrite === 'trash') {
      this.suppress(this.internalSuppressed, entry.relativePath, 2500);
      await vscode.workspace.fs.delete(vscode.Uri.file(entry.fsPath), {
        useTrash: true,
      });
    }

    if (plan.restorePending) {
      this.store.upsertPending(plan.restorePending);
    } else {
      this.store.removePending(entry.relativePath);
    }

    if (plan.restoreCleanBaseline !== null) {
      this.store.setCleanBaseline(entry.relativePath, plan.restoreCleanBaseline);
    } else {
      this.store.deleteCleanBaseline(entry.relativePath);
    }

    await this.persistNow();
    this._onDidChange.fire(entry.relativePath);

    const suffix = plan.mergedWithSubsequentEdits
      ? ' (3-way merged with subsequent edits)'
      : '';
    return {
      ok: true,
      message: `Undid: ${entry.description}${suffix}`,
    };
  }

  async importGitChanges(): Promise<number> {
    if (!this.isGit) {
      this.isGit = await this.gitService.isGitRepo();
    }
    if (!this.isGit) {
      void vscode.window.showInformationMessage(
        'Current workspace is not a Git repository.'
      );
      return 0;
    }

    const cfg = this.getConfig();
    const dirty = await this.gitService.getDirtyFiles();
    let imported = 0;

    for (const entry of dirty) {
      if (isPathIgnoredByDefault(entry.relativePath, cfg.excludePatterns)) {
        continue;
      }
      const fsPath = path.join(this.workspaceRoot, entry.relativePath);
      const isDeleted = entry.status.includes('D');

      if (isDeleted) {
        const head = await this.gitService.getHeadContent(entry.relativePath);
        if (head !== null) {
          this.store.upsertPending({
            relativePath: entry.relativePath,
            fsPath,
            kind: 'deleted',
            baselineContent: head,
            updatedAt: Date.now(),
          });
          imported += 1;
        }
        continue;
      }

      const disk = await this.readDiskTextIfTrackable(fsPath, cfg.maxFileSizeKB);
      if (disk === null) {
        continue;
      }
      const head = await this.gitService.getHeadContent(entry.relativePath);
      if (head === null) {
        this.store.upsertPending({
          relativePath: entry.relativePath,
          fsPath,
          kind: 'created',
          baselineContent: null,
          updatedAt: Date.now(),
        });
        imported += 1;
      } else if (normalizeNewlines(head) !== normalizeNewlines(disk)) {
        this.store.upsertPending({
          relativePath: entry.relativePath,
          fsPath,
          kind: 'modified',
          baselineContent: head,
          updatedAt: Date.now(),
        });
        imported += 1;
      }
    }

    if (imported > 0) {
      await this.persistNow();
      this._onDidChange.fire(undefined);
    }
    return imported;
  }

  async refreshAll(): Promise<void> {
    await this.pruneResolvedPending();
    await this.persistNow();
    this._onDidChange.fire(undefined);
  }

  private async applyTextUpdate(
    relativePath: string,
    fsPath: string,
    nextContent: string,
    autoSave: boolean
  ): Promise<boolean> {
    this.suppress(this.internalSuppressed, relativePath, 2500);
    try {
      const uri = vscode.Uri.file(fsPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const before = doc.getText();
      const minimal = computeMinimalTextEdit(before, nextContent);

      if (minimal) {
        const edit = new vscode.WorkspaceEdit();
        const startPos = doc.positionAt(minimal.startOffset);
        const endPos = doc.positionAt(minimal.endOffset);
        edit.replace(uri, new vscode.Range(startPos, endPos), minimal.replacement);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
          return false;
        }
      }

      if (autoSave) {
        await doc.save();
      }
      return true;
    } catch {
      return false;
    }
  }

  private schedulePersist(): void {
    if (!this.getConfig().persistState) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 250);
  }

  async persistNow(): Promise<void> {
    if (!this.getConfig().persistState) {
      return;
    }
    try {
      const dirUri = this.context.storageUri ?? this.context.globalStorageUri;
      await vscode.workspace.fs.createDirectory(dirUri);
      const json = JSON.stringify(this.store.serialize());
      await vscode.workspace.fs.writeFile(
        this.getStateUri(),
        Buffer.from(json, 'utf8')
      );
    } catch {
      // Ignore storage write failures
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    if (this.docChangeTimer) {
      clearTimeout(this.docChangeTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
    this._onDidFileResolved.dispose();
  }
}
