import { diffArrays } from 'diff';
import type { DiffHunk, FileStats, MinimalTextEdit } from '../types.js';

export type EolStyle = '\r\n' | '\n';

export interface SplitLinesResult {
  lines: string[];
  hasTrailingNewline: boolean;
}

export function detectEol(text: string): EolStyle {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function splitLinesPreserveTrailing(normalizedText: string): SplitLinesResult {
  if (normalizedText.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  const hasTrailingNewline = normalizedText.endsWith('\n');
  const trimmed = hasTrailingNewline ? normalizedText.slice(0, -1) : normalizedText;
  const lines = trimmed.split('\n');
  return { lines, hasTrailingNewline };
}

export function joinLines(
  lines: string[],
  hasTrailingNewline: boolean,
  eol: EolStyle
): string {
  if (lines.length === 0) {
    return hasTrailingNewline ? eol : '';
  }
  return lines.join(eol) + (hasTrailingNewline ? eol : '');
}

function formatHunkHeader(
  oldCount: number,
  newStart: number,
  newCount: number
): string {
  const lineNumber = newStart + 1;
  return `L${lineNumber} (+${newCount} -${oldCount})`;
}

export function computeHunks(baseline: string, current: string): DiffHunk[] {
  const oldParsed = splitLinesPreserveTrailing(normalizeNewlines(baseline));
  const newParsed = splitLinesPreserveTrailing(normalizeNewlines(current));

  const changes = diffArrays(oldParsed.lines, newParsed.lines);

  const hunks: DiffHunk[] = [];
  let oldCursor = 0;
  let newCursor = 0;

  let i = 0;
  while (i < changes.length) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      const len = part.value.length;
      oldCursor += len;
      newCursor += len;
      i += 1;
      continue;
    }

    const oldStart = oldCursor;
    const newStart = newCursor;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    // Coalesce contiguous removed/added segments into a single hunk.
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const seg = changes[i];
      if (seg.removed) {
        oldLines.push(...seg.value);
        oldCursor += seg.value.length;
      } else if (seg.added) {
        newLines.push(...seg.value);
        newCursor += seg.value.length;
      }
      i += 1;
    }

    hunks.push({
      index: hunks.length,
      oldStart,
      oldCount: oldLines.length,
      newStart,
      newCount: newLines.length,
      oldLines,
      newLines,
      header: formatHunkHeader(oldLines.length, newStart, newLines.length),
    });
  }

  return hunks;
}

export function computeStats(hunks: DiffHunk[]): FileStats {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    additions += h.newCount;
    deletions += h.oldCount;
  }
  return { additions, deletions, hunkCount: hunks.length };
}

export function applyHunkToBaseline(
  baseline: string,
  current: string,
  hunkIndex: number
): { nextBaseline: string; remainingHunks: DiffHunk[] } {
  const hunks = computeHunks(baseline, current);
  if (hunkIndex < 0 || hunkIndex >= hunks.length) {
    throw new RangeError(`Hunk index ${hunkIndex} out of range (0..${hunks.length - 1})`);
  }

  const hunk = hunks[hunkIndex];
  const eol = detectEol(baseline.length > 0 ? baseline : current);
  const oldParsed = splitLinesPreserveTrailing(normalizeNewlines(baseline));
  const newParsed = splitLinesPreserveTrailing(normalizeNewlines(current));

  const touchesEof = hunk.oldStart + hunk.oldCount === oldParsed.lines.length;
  const nextLines = [...oldParsed.lines];
  nextLines.splice(hunk.oldStart, hunk.oldCount, ...hunk.newLines);

  const nextHasTrailing = touchesEof
    ? newParsed.hasTrailingNewline
    : oldParsed.hasTrailingNewline;
  const nextBaseline = joinLines(nextLines, nextHasTrailing, eol);
  const remainingHunks = computeHunks(nextBaseline, current);

  return { nextBaseline, remainingHunks };
}

export function revertHunkInCurrent(
  baseline: string,
  current: string,
  hunkIndex: number
): { nextCurrent: string; remainingHunks: DiffHunk[] } {
  const hunks = computeHunks(baseline, current);
  if (hunkIndex < 0 || hunkIndex >= hunks.length) {
    throw new RangeError(`Hunk index ${hunkIndex} out of range (0..${hunks.length - 1})`);
  }

  const hunk = hunks[hunkIndex];
  const eol = detectEol(current.length > 0 ? current : baseline);
  const oldParsed = splitLinesPreserveTrailing(normalizeNewlines(baseline));
  const newParsed = splitLinesPreserveTrailing(normalizeNewlines(current));

  const touchesEof = hunk.newStart + hunk.newCount === newParsed.lines.length;
  const nextLines = [...newParsed.lines];
  nextLines.splice(hunk.newStart, hunk.newCount, ...hunk.oldLines);

  const nextHasTrailing = touchesEof
    ? oldParsed.hasTrailingNewline
    : newParsed.hasTrailingNewline;
  const nextCurrent = joinLines(nextLines, nextHasTrailing, eol);
  const remainingHunks = computeHunks(baseline, nextCurrent);

  return { nextCurrent, remainingHunks };
}

export function computeMinimalTextEdit(
  before: string,
  after: string
): MinimalTextEdit | null {
  if (before === after) {
    return null;
  }

  const minLen = Math.min(before.length, after.length);
  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    before.charCodeAt(prefixLen) === after.charCodeAt(prefixLen)
  ) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  const maxSuffix = minLen - prefixLen;
  while (
    suffixLen < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffixLen) ===
      after.charCodeAt(after.length - 1 - suffixLen)
  ) {
    suffixLen += 1;
  }

  return {
    startOffset: prefixLen,
    endOffset: before.length - suffixLen,
    replacement: after.slice(prefixLen, after.length - suffixLen),
  };
}

export function isCursorInHunk(hunk: DiffHunk, cursorLine: number): boolean {
  if (hunk.newCount > 0) {
    return (
      cursorLine >= hunk.newStart &&
      cursorLine < hunk.newStart + hunk.newCount
    );
  }
  // Pure deletion anchor sits at hunk.newStart (or line just above if at EOF).
  return (
    cursorLine === hunk.newStart ||
    (hunk.newStart > 0 && cursorLine === hunk.newStart - 1)
  );
}

export function findTargetHunkIndex(
  hunks: DiffHunk[],
  cursorLine: number,
  maxProximity = 3
): { exactOrNearIndex: number | null; nextIndex: number | null } {
  if (hunks.length === 0) {
    return { exactOrNearIndex: null, nextIndex: null };
  }

  // 1. Exact containment match
  for (let i = 0; i < hunks.length; i += 1) {
    if (isCursorInHunk(hunks[i], cursorLine)) {
      return { exactOrNearIndex: i, nextIndex: i };
    }
  }

  // 2. Single hunk in file: safe to act directly if within proximity or sole hunk
  if (hunks.length === 1) {
    return { exactOrNearIndex: 0, nextIndex: 0 };
  }

  // 3. Nearest hunk within small proximity threshold
  let closestIdx = 0;
  let closestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hunks.length; i += 1) {
    const h = hunks[i];
    const start = h.newStart;
    const end = h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart;
    const dist =
      cursorLine < start ? start - cursorLine : cursorLine > end ? cursorLine - end : 0;
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }

  if (closestDist <= maxProximity) {
    return { exactOrNearIndex: closestIdx, nextIndex: closestIdx };
  }

  // 4. Cursor is far away: suggest next hunk downward (or wrap to 0) for jump-before-confirm
  const downward = hunks.findIndex((h) => h.newStart >= cursorLine);
  return {
    exactOrNearIndex: null,
    nextIndex: downward >= 0 ? downward : 0,
  };
}

export function findExactHunkIndexForLine(
  hunks: DiffHunk[],
  line: number,
  side: 'new' | 'old'
): number | null {
  for (let i = 0; i < hunks.length; i += 1) {
    const h = hunks[i];
    if (side === 'new') {
      if (isCursorInHunk(h, line)) {
        return i;
      }
    } else if (h.oldCount > 0) {
      if (line >= h.oldStart && line < h.oldStart + h.oldCount) {
        return i;
      }
    } else if (line === h.oldStart) {
      return i;
    }
  }
  return null;
}

export function formatHunkLineRange(hunk: DiffHunk): string {
  const start = hunk.newStart + 1;
  if (hunk.newCount > 1) {
    return `L${start}–L${start + hunk.newCount - 1}`;
  }
  return `L${start}`;
}

export function getHunkPreviewLine(hunk: DiffHunk, maxLen = 64): string {
  const candidates = hunk.newLines.length > 0 ? hunk.newLines : hunk.oldLines;
  const firstNonEmpty = candidates.find((line) => line.trim().length > 0) ?? candidates[0] ?? '';
  const trimmed = firstNonEmpty.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return trimmed.slice(0, Math.max(1, maxLen - 1)) + '…';
}
