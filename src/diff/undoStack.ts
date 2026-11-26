import type { PendingFileReview, ReviewUndoEntry } from '../types.js';
import { normalizeNewlines } from './diffEngine.js';
import { threeWayMerge } from './threeWayMerge.js';

export type UndoPlan =
  | {
      ok: true;
      fileWrite: 'none' | 'write' | 'create' | 'trash';
      nextContent?: string;
      mergedWithSubsequentEdits?: boolean;
      restorePending: PendingFileReview | null;
      restoreCleanBaseline: string | null;
    }
  | {
      ok: false;
      conflict: true;
      reason: string;
    };

export class UndoStack {
  private entries: ReviewUndoEntry[] = [];

  constructor(private readonly maxSize = 100) {}

  push(entry: ReviewUndoEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  peek(): ReviewUndoEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  pop(): ReviewUndoEntry | undefined {
    return this.entries.pop();
  }

  canUndo(): boolean {
    return this.entries.length > 0;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

export function planUndoAction(
  entry: ReviewUndoEntry,
  currentDiskContent: string | null
): UndoPlan {
  if (entry.type === 'accept') {
    return {
      ok: true,
      fileWrite: 'none',
      restorePending: entry.previousPending,
      restoreCleanBaseline: entry.previousCleanBaseline,
    };
  }

  const { contentBeforeReject, contentAfterReject } = entry;

  // Case 1: Standard reject of modified file/hunk (existed before and after reject)
  if (contentBeforeReject !== null && contentAfterReject !== null) {
    if (currentDiskContent === null) {
      return {
        ok: false,
        conflict: true,
        reason: 'File was deleted after the reject action.',
      };
    }

    if (normalizeNewlines(currentDiskContent) === normalizeNewlines(contentAfterReject)) {
      return {
        ok: true,
        fileWrite: 'write',
        nextContent: contentBeforeReject,
        restorePending: entry.previousPending,
        restoreCleanBaseline: entry.previousCleanBaseline,
      };
    }

    const merged = threeWayMerge(
      contentAfterReject,
      contentBeforeReject,
      currentDiskContent
    );
    if (!merged.ok) {
      return {
        ok: false,
        conflict: true,
        reason: `${merged.reason}. Subsequent edits overlap the rejected hunk.`,
      };
    }

    return {
      ok: true,
      fileWrite: 'write',
      nextContent: merged.content,
      mergedWithSubsequentEdits: true,
      restorePending: entry.previousPending,
      restoreCleanBaseline: entry.previousCleanBaseline,
    };
  }

  // Case 2: Undoing reject of a newly created file that was trashed
  if (contentBeforeReject !== null && contentAfterReject === null) {
    if (currentDiskContent === null) {
      return {
        ok: true,
        fileWrite: 'create',
        nextContent: contentBeforeReject,
        restorePending: entry.previousPending,
        restoreCleanBaseline: entry.previousCleanBaseline,
      };
    }
    return {
      ok: false,
      conflict: true,
      reason: 'A new file now exists at this path.',
    };
  }

  // Case 3: Undoing reject of a deleted file that was restored
  if (contentBeforeReject === null && contentAfterReject !== null) {
    if (
      currentDiskContent !== null &&
      normalizeNewlines(currentDiskContent) === normalizeNewlines(contentAfterReject)
    ) {
      return {
        ok: true,
        fileWrite: 'trash',
        restorePending: entry.previousPending,
        restoreCleanBaseline: entry.previousCleanBaseline,
      };
    }
    return {
      ok: false,
      conflict: true,
      reason: 'The restored file was subsequently modified or deleted.',
    };
  }

  return {
    ok: false,
    conflict: true,
    reason: 'Invalid undo entry state.',
  };
}
