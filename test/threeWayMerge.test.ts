import { describe, expect, it } from 'vitest';
import { threeWayMerge } from '../src/diff/threeWayMerge.js';

describe('threeWayMerge', () => {
  it('returns clean result when only one side changed or both made identical edits', () => {
    const base = 'a\nb\nc\n';
    expect(threeWayMerge(base, 'a\nb2\nc\n', base)).toEqual({
      ok: true,
      content: 'a\nb2\nc\n',
    });
    expect(threeWayMerge(base, base, 'a\nb\nc2\n')).toEqual({
      ok: true,
      content: 'a\nb\nc2\n',
    });
    expect(threeWayMerge(base, 'a\nb2\nc\n', 'a\nb2\nc\n')).toEqual({
      ok: true,
      content: 'a\nb2\nc\n',
    });
  });

  it('merges non-overlapping edits before and after the target region (line shift)', () => {
    const base = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', ''].join('\n');
    // ours restores L5 -> L5_restored
    const ours = ['L1', 'L2', 'L3', 'L4', 'L5_restored', 'L6', ''].join('\n');
    // theirs inserts 2 lines near top (shifting L5 down by 2 lines)
    const theirs = ['L1', 'X1', 'X2', 'L2', 'L3', 'L4', 'L5', 'L6', ''].join('\n');

    const result = threeWayMerge(base, ours, theirs);
    expect(result).toEqual({
      ok: true,
      content: ['L1', 'X1', 'X2', 'L2', 'L3', 'L4', 'L5_restored', 'L6', ''].join('\n'),
    });
  });

  it('merges non-overlapping edits when subsequent edit is below', () => {
    const base = ['L1', 'L2', 'L3', 'L4', 'L5', ''].join('\n');
    const ours = ['L1_restored', 'L2', 'L3', 'L4', 'L5', ''].join('\n');
    const theirs = ['L1', 'L2', 'L3', 'L4', 'L5_edited', ''].join('\n');

    expect(threeWayMerge(base, ours, theirs)).toEqual({
      ok: true,
      content: ['L1_restored', 'L2', 'L3', 'L4', 'L5_edited', ''].join('\n'),
    });
  });

  it('detects conflict when both sides modify overlapping lines differently', () => {
    const base = ['L1', 'L2', 'L3', ''].join('\n');
    const ours = ['L1', 'L2_ours', 'L3', ''].join('\n');
    const theirs = ['L1', 'L2_theirs', 'L3', ''].join('\n');

    const result = threeWayMerge(base, ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
    }
  });

  it('detects conflict when two different pure insertions land at the exact same line', () => {
    const base = ['L1', 'L2', ''].join('\n');
    const ours = ['L1', 'insertA', 'L2', ''].join('\n');
    const theirs = ['L1', 'insertB', 'L2', ''].join('\n');

    const result = threeWayMerge(base, ours, theirs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
    }
  });

  it('preserves CRLF line endings from theirs', () => {
    const base = 'L1\r\nL2\r\nL3\r\n';
    const ours = 'L1_old\r\nL2\r\nL3\r\n';
    const theirs = 'L1\r\nL2\r\nL3_new\r\n';

    expect(threeWayMerge(base, ours, theirs)).toEqual({
      ok: true,
      content: 'L1_old\r\nL2\r\nL3_new\r\n',
    });
  });
});
