import { describe, expect, it } from 'vitest';
import { planUndoAction, UndoStack } from '../src/diff/undoStack.js';
import type { PendingFileReview, ReviewUndoEntry } from '../src/types.js';

function makePending(baselineContent: string | null): PendingFileReview {
  return {
    relativePath: 'src/app.ts',
    fsPath: '/repo/src/app.ts',
    kind: baselineContent === null ? 'created' : 'modified',
    baselineContent,
    updatedAt: 1000,
  };
}

describe('undoStack & planUndoAction', () => {
  it('supports push, pop, peek, and max capacity', () => {
    const stack = new UndoStack(2);
    expect(stack.canUndo()).toBe(false);

    const e1: ReviewUndoEntry = {
      type: 'accept',
      relativePath: 'a.ts',
      fsPath: '/a.ts',
      description: 'e1',
      previousPending: makePending('a'),
      previousCleanBaseline: 'a',
    };
    const e2 = { ...e1, description: 'e2' };
    const e3 = { ...e1, description: 'e3' };

    stack.push(e1);
    stack.push(e2);
    stack.push(e3);

    expect(stack.size()).toBe(2);
    expect(stack.peek()?.description).toBe('e3');
    expect(stack.pop()?.description).toBe('e3');
    expect(stack.pop()?.description).toBe('e2');
    expect(stack.pop()).toBeUndefined();
  });

  it('undoes Accept losslessly without touching disk even after subsequent edits', () => {
    const entry: ReviewUndoEntry = {
      type: 'accept',
      relativePath: 'src/app.ts',
      fsPath: '/repo/src/app.ts',
      description: 'Accept hunk #1',
      previousPending: makePending('oldLine1\noldLine2\n'),
      previousCleanBaseline: 'oldLine1\noldLine2\n',
    };

    // Even if user/agent heavily edited the file afterwards, undo Accept only restores baseline!
    const plan = planUndoAction(entry, 'completelyNew\nuserEditedCode\n');
    expect(plan).toEqual({
      ok: true,
      fileWrite: 'none',
      restorePending: entry.previousPending,
      restoreCleanBaseline: entry.previousCleanBaseline,
    });
  });

  it('undoes Reject directly when file was not modified afterward', () => {
    const entry: ReviewUndoEntry = {
      type: 'reject',
      relativePath: 'src/app.ts',
      fsPath: '/repo/src/app.ts',
      description: 'Reject hunk #1',
      previousPending: makePending('a\nb\nc\n'),
      previousCleanBaseline: 'a\nb\nc\n',
      contentBeforeReject: 'a\nb_agent\nc\n',
      contentAfterReject: 'a\nb\nc\n',
    };

    const plan = planUndoAction(entry, 'a\nb\nc\n');
    expect(plan).toEqual({
      ok: true,
      fileWrite: 'write',
      nextContent: 'a\nb_agent\nc\n',
      restorePending: entry.previousPending,
      restoreCleanBaseline: entry.previousCleanBaseline,
    });
  });

  it('undoes Reject via 3-way merge when subsequent edits occurred elsewhere (line shift safe)', () => {
    const contentAfterReject = ['L1', 'L2', 'L3', 'L4', 'L5', ''].join('\n');
    const contentBeforeReject = ['L1', 'L2', 'L3', 'L4', 'L5_agent', ''].join('\n');
    const subsequentDisk = ['L0_added', 'L1', 'L2', 'L3', 'L4', 'L5', ''].join('\n');

    const entry: ReviewUndoEntry = {
      type: 'reject',
      relativePath: 'src/app.ts',
      fsPath: '/repo/src/app.ts',
      description: 'Reject hunk #1',
      previousPending: makePending(contentAfterReject),
      previousCleanBaseline: contentAfterReject,
      contentBeforeReject,
      contentAfterReject,
    };

    const plan = planUndoAction(entry, subsequentDisk);
    expect(plan).toEqual({
      ok: true,
      fileWrite: 'write',
      nextContent: ['L0_added', 'L1', 'L2', 'L3', 'L4', 'L5_agent', ''].join('\n'),
      mergedWithSubsequentEdits: true,
      restorePending: entry.previousPending,
      restoreCleanBaseline: entry.previousCleanBaseline,
    });
  });

  it('refuses blind overwrite and reports conflict when subsequent edits overlap rejected region', () => {
    const contentAfterReject = ['L1', 'L2', 'L3', ''].join('\n');
    const contentBeforeReject = ['L1', 'L2_agent', 'L3', ''].join('\n');
    const subsequentDisk = ['L1', 'L2_manual_override', 'L3', ''].join('\n');

    const entry: ReviewUndoEntry = {
      type: 'reject',
      relativePath: 'src/app.ts',
      fsPath: '/repo/src/app.ts',
      description: 'Reject hunk #1',
      previousPending: makePending(contentAfterReject),
      previousCleanBaseline: contentAfterReject,
      contentBeforeReject,
      contentAfterReject,
    };

    const plan = planUndoAction(entry, subsequentDisk);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.conflict).toBe(true);
    }
  });

  it('handles undo Reject for created and deleted files safely', () => {
    const rejectCreated: ReviewUndoEntry = {
      type: 'reject',
      relativePath: 'src/new.ts',
      fsPath: '/repo/src/new.ts',
      description: 'Reject created file',
      previousPending: makePending(null),
      previousCleanBaseline: null,
      contentBeforeReject: 'export const x = 1;\n',
      contentAfterReject: null,
    };

    expect(planUndoAction(rejectCreated, null)).toEqual({
      ok: true,
      fileWrite: 'create',
      nextContent: 'export const x = 1;\n',
      restorePending: rejectCreated.previousPending,
      restoreCleanBaseline: null,
    });
    expect(planUndoAction(rejectCreated, 'someone recreated it').ok).toBe(false);

    const rejectDeleted: ReviewUndoEntry = {
      type: 'reject',
      relativePath: 'src/old.ts',
      fsPath: '/repo/src/old.ts',
      description: 'Restore deleted file',
      previousPending: {
        relativePath: 'src/old.ts',
        fsPath: '/repo/src/old.ts',
        kind: 'deleted',
        baselineContent: 'old code\n',
        updatedAt: 1000,
      },
      previousCleanBaseline: 'old code\n',
      contentBeforeReject: null,
      contentAfterReject: 'old code\n',
    };

    expect(planUndoAction(rejectDeleted, 'old code\n')).toEqual({
      ok: true,
      fileWrite: 'trash',
      restorePending: rejectDeleted.previousPending,
      restoreCleanBaseline: 'old code\n',
    });
    expect(planUndoAction(rejectDeleted, 'edited afterward\n').ok).toBe(false);
  });
});
