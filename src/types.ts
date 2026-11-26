export type ChangeKind = 'modified' | 'created' | 'deleted';

export interface DiffHunk {
  index: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
  header: string;
}

export interface FileStats {
  additions: number;
  deletions: number;
  hunkCount: number;
}

export interface PendingFileReview {
  relativePath: string;
  fsPath: string;
  kind: ChangeKind;
  /** Baseline file content before agent edits; null when kind === 'created'. */
  baselineContent: string | null;
  updatedAt: number;
}

export interface AcceptUndoEntry {
  type: 'accept';
  relativePath: string;
  fsPath: string;
  description: string;
  previousPending: PendingFileReview | null;
  previousCleanBaseline: string | null;
}

export interface RejectUndoEntry {
  type: 'reject';
  relativePath: string;
  fsPath: string;
  description: string;
  previousPending: PendingFileReview | null;
  previousCleanBaseline: string | null;
  /** File content right before Reject ran; null if file did not exist (e.g., deleted file). */
  contentBeforeReject: string | null;
  /** File content right after Reject ran; null if file was deleted/trashed. */
  contentAfterReject: string | null;
}

export type ReviewUndoEntry = AcceptUndoEntry | RejectUndoEntry;

export type MergeResult =
  | { ok: true; content: string }
  | { ok: false; conflict: true; reason: string };

export interface MinimalTextEdit {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

export interface PersistedState {
  version: 1;
  pendingReviews: Record<string, PendingFileReview>;
  cleanBaselines: Record<string, string>;
}
