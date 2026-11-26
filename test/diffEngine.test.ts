import { describe, expect, it } from 'vitest';
import {
  applyHunkToBaseline,
  computeHunks,
  computeMinimalTextEdit,
  computeStats,
  findTargetHunkIndex,
  revertHunkInCurrent,
} from '../src/diff/diffEngine.js';

describe('diffEngine', () => {
  it('computes empty hunks for identical content (even across LF/CRLF)', () => {
    expect(computeHunks('a\nb\n', 'a\r\nb\r\n')).toEqual([]);
    expect(computeHunks('', '')).toEqual([]);
  });

  it('handles pure insertion, pure deletion, and replacement hunks', () => {
    const base = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', ''].join('\n');
    const curr = [
      'line1',
      'insertedA',
      'line2',
      'line3',
      'line4_mod',
      'line5',
      '',
    ].join('\n');

    const hunks = computeHunks(base, curr);
    expect(hunks).toHaveLength(3);

    expect(hunks[0]).toMatchObject({
      index: 0,
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
      oldLines: [],
      newLines: ['insertedA'],
    });

    expect(hunks[1]).toMatchObject({
      index: 1,
      oldStart: 3,
      oldCount: 1,
      newStart: 4,
      newCount: 1,
      oldLines: ['line4'],
      newLines: ['line4_mod'],
    });

    expect(hunks[2]).toMatchObject({
      index: 2,
      oldStart: 5,
      oldCount: 1,
      newStart: 6,
      newCount: 0,
      oldLines: ['line6'],
      newLines: [],
    });

    expect(computeStats(hunks)).toEqual({
      additions: 2,
      deletions: 2,
      hunkCount: 3,
    });
  });

  it('handles empty baseline creation and full deletion', () => {
    const createdHunks = computeHunks('', 'hello\nworld\n');
    expect(createdHunks).toHaveLength(1);
    expect(createdHunks[0].oldCount).toBe(0);
    expect(createdHunks[0].newLines).toEqual(['hello', 'world']);

    const deletedHunks = computeHunks('hello\nworld\n', '');
    expect(deletedHunks).toHaveLength(1);
    expect(deletedHunks[0].newCount).toBe(0);
    expect(deletedHunks[0].oldLines).toEqual(['hello', 'world']);
  });

  it('sequentially applies hunks to baseline until 0 hunks remain while preserving CRLF', () => {
    const base = 'a\r\nb\r\nc\r\nd\r\n';
    const curr = 'a\r\nb_new\r\nc\r\nd_new\r\ne_new\r\n';

    const step1 = applyHunkToBaseline(base, curr, 0);
    expect(step1.nextBaseline).toBe('a\r\nb_new\r\nc\r\nd\r\n');
    expect(step1.remainingHunks).toHaveLength(1);

    const step2 = applyHunkToBaseline(step1.nextBaseline, curr, 0);
    expect(step2.nextBaseline).toBe(curr);
    expect(step2.remainingHunks).toHaveLength(0);
  });

  it('sequentially reverts hunks in current until 0 hunks remain while preserving no-trailing-newline', () => {
    const base = 'one\ntwo\nthree';
    const curr = 'one_mod\ntwo\nthree\nfour\n';

    const step1 = revertHunkInCurrent(base, curr, 1);
    expect(step1.nextCurrent).toBe('one_mod\ntwo\nthree');
    expect(step1.remainingHunks).toHaveLength(1);

    const step2 = revertHunkInCurrent(base, step1.nextCurrent, 0);
    expect(step2.nextCurrent).toBe(base);
    expect(step2.remainingHunks).toHaveLength(0);
  });

  it('computes exact minimal text edits across edge cases', () => {
    const cases: Array<[string, string]> = [
      ['abc', 'abc'],
      ['', 'hello\n'],
      ['hello\n', ''],
      ['a\r\nb\r\nc\r\n', 'a\r\nb2\r\nc\r\n'],
      ['prefix_old_suffix', 'prefix_new_suffix'],
      ['same\nsame\n', 'same\nextra\nsame\n'],
    ];

    for (const [before, after] of cases) {
      const edit = computeMinimalTextEdit(before, after);
      if (before === after) {
        expect(edit).toBeNull();
      } else {
        expect(edit).not.toBeNull();
        const reconstructed =
          before.slice(0, edit!.startOffset) +
          edit!.replacement +
          before.slice(edit!.endOffset);
        expect(reconstructed).toBe(after);
      }
    }
  });

  it('finds target hunk accurately for cursor inside, deletion anchor, sole hunk, and far away', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n') + '\n';
    const currLines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    currLines[2] = 'line2_mod';
    currLines.splice(20, 1); // deletion at newStart = 20
    const curr = currLines.join('\n') + '\n';

    const hunks = computeHunks(base, curr);
    expect(hunks).toHaveLength(2);

    expect(findTargetHunkIndex(hunks, 2)).toEqual({
      exactOrNearIndex: 0,
      nextIndex: 0,
    });

    // Cursor on pure deletion anchor (newStart = 20)
    expect(findTargetHunkIndex(hunks, 20)).toEqual({
      exactOrNearIndex: 1,
      nextIndex: 1,
    });

    // Cursor far away (line 10) -> suggests jumping to hunk 1 first
    expect(findTargetHunkIndex(hunks, 10)).toEqual({
      exactOrNearIndex: null,
      nextIndex: 1,
    });

    // Single hunk file resolves regardless of distance
    expect(findTargetHunkIndex([hunks[1]], 0)).toEqual({
      exactOrNearIndex: 0,
      nextIndex: 0,
    });
  });
});
