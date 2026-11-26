import type { PendingFileReview, PersistedState } from '../types.js';
import { normalizeNewlines } from '../diff/diffEngine.js';

export type ExternalChangeOutcome = 'added' | 'updated' | 'resolved' | 'noop';

export class ReviewStore {
  private pendingReviews = new Map<string, PendingFileReview>();
  private cleanBaselines = new Map<string, string>();

  getPending(relativePath: string): PendingFileReview | undefined {
    return this.pendingReviews.get(relativePath);
  }

  getAllPending(): PendingFileReview[] {
    return Array.from(this.pendingReviews.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
  }

  hasPending(relativePath: string): boolean {
    return this.pendingReviews.has(relativePath);
  }

  getPendingCount(): number {
    return this.pendingReviews.size;
  }

  getCleanBaseline(relativePath: string): string | undefined {
    return this.cleanBaselines.get(relativePath);
  }

  setCleanBaseline(relativePath: string, content: string): void {
    this.cleanBaselines.set(relativePath, content);
  }

  deleteCleanBaseline(relativePath: string): void {
    this.cleanBaselines.delete(relativePath);
  }

  upsertPending(review: PendingFileReview): void {
    this.pendingReviews.set(review.relativePath, { ...review });
  }

  removePending(relativePath: string): void {
    this.pendingReviews.delete(relativePath);
  }

  recordExternalModification(
    relativePath: string,
    fsPath: string,
    currentContent: string,
    fallbackBaseline: string | null,
    now = Date.now()
  ): ExternalChangeOutcome {
    const existing = this.pendingReviews.get(relativePath);
    if (existing) {
      // If file was deleted and recreated/modified back, compare against original baseline.
      if (
        existing.baselineContent !== null &&
        normalizeNewlines(existing.baselineContent) ===
          normalizeNewlines(currentContent)
      ) {
        this.pendingReviews.delete(relativePath);
        this.cleanBaselines.set(relativePath, existing.baselineContent);
        return 'resolved';
      }
      this.pendingReviews.set(relativePath, {
        ...existing,
        fsPath,
        kind: existing.baselineContent === null ? 'created' : 'modified',
        updatedAt: now,
      });
      return 'updated';
    }

    const baseline =
      this.cleanBaselines.has(relativePath)
        ? this.cleanBaselines.get(relativePath)!
        : fallbackBaseline;

    if (baseline === null) {
      // Unknown prior baseline (e.g., untracked file created before watcher saw it)
      this.pendingReviews.set(relativePath, {
        relativePath,
        fsPath,
        kind: 'created',
        baselineContent: null,
        updatedAt: now,
      });
      return 'added';
    }

    if (normalizeNewlines(baseline) === normalizeNewlines(currentContent)) {
      this.cleanBaselines.set(relativePath, baseline);
      return 'noop';
    }

    this.pendingReviews.set(relativePath, {
      relativePath,
      fsPath,
      kind: 'modified',
      baselineContent: baseline,
      updatedAt: now,
    });
    return 'added';
  }

  recordExternalCreation(
    relativePath: string,
    fsPath: string,
    currentContent: string,
    now = Date.now()
  ): ExternalChangeOutcome {
    const existing = this.pendingReviews.get(relativePath);
    if (existing) {
      if (existing.kind === 'deleted' && existing.baselineContent !== null) {
        if (
          normalizeNewlines(existing.baselineContent) ===
          normalizeNewlines(currentContent)
        ) {
          this.pendingReviews.delete(relativePath);
          this.cleanBaselines.set(relativePath, existing.baselineContent);
          return 'resolved';
        }
        this.pendingReviews.set(relativePath, {
          ...existing,
          fsPath,
          kind: 'modified',
          updatedAt: now,
        });
        return 'updated';
      }
      this.pendingReviews.set(relativePath, {
        ...existing,
        fsPath,
        updatedAt: now,
      });
      return 'updated';
    }

    const cleanBaseline = this.cleanBaselines.get(relativePath);
    if (cleanBaseline !== undefined) {
      if (normalizeNewlines(cleanBaseline) === normalizeNewlines(currentContent)) {
        return 'noop';
      }
      this.pendingReviews.set(relativePath, {
        relativePath,
        fsPath,
        kind: 'modified',
        baselineContent: cleanBaseline,
        updatedAt: now,
      });
      return 'added';
    }

    this.pendingReviews.set(relativePath, {
      relativePath,
      fsPath,
      kind: 'created',
      baselineContent: null,
      updatedAt: now,
    });
    return 'added';
  }

  recordExternalDeletion(
    relativePath: string,
    fsPath: string,
    fallbackBaseline: string | null,
    now = Date.now()
  ): ExternalChangeOutcome {
    const existing = this.pendingReviews.get(relativePath);
    if (existing) {
      if (existing.kind === 'created') {
        this.pendingReviews.delete(relativePath);
        return 'resolved';
      }
      if (existing.baselineContent !== null) {
        this.pendingReviews.set(relativePath, {
          ...existing,
          fsPath,
          kind: 'deleted',
          updatedAt: now,
        });
        return 'updated';
      }
      return 'noop';
    }

    const baseline =
      this.cleanBaselines.has(relativePath)
        ? this.cleanBaselines.get(relativePath)!
        : fallbackBaseline;

    if (baseline === null) {
      return 'noop';
    }

    this.pendingReviews.set(relativePath, {
      relativePath,
      fsPath,
      kind: 'deleted',
      baselineContent: baseline,
      updatedAt: now,
    });
    return 'added';
  }

  serialize(): PersistedState {
    const pendingReviews: Record<string, PendingFileReview> = {};
    for (const [k, v] of this.pendingReviews.entries()) {
      pendingReviews[k] = { ...v };
    }
    const cleanBaselines: Record<string, string> = {};
    for (const [k, v] of this.cleanBaselines.entries()) {
      cleanBaselines[k] = v;
    }
    return {
      version: 1,
      pendingReviews,
      cleanBaselines,
    };
  }

  hydrate(state: unknown): void {
    this.pendingReviews.clear();
    this.cleanBaselines.clear();
    if (!state || typeof state !== 'object') {
      return;
    }
    const parsed = state as Partial<PersistedState>;
    if (parsed.version !== 1) {
      return;
    }
    if (parsed.pendingReviews && typeof parsed.pendingReviews === 'object') {
      for (const [k, v] of Object.entries(parsed.pendingReviews)) {
        if (v && typeof v.relativePath === 'string' && typeof v.fsPath === 'string') {
          this.pendingReviews.set(k, { ...v });
        }
      }
    }
    if (parsed.cleanBaselines && typeof parsed.cleanBaselines === 'object') {
      for (const [k, v] of Object.entries(parsed.cleanBaselines)) {
        if (typeof v === 'string') {
          this.cleanBaselines.set(k, v);
        }
      }
    }
  }
}
