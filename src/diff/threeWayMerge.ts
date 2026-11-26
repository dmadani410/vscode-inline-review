import { diffArrays } from 'diff';
import type { MergeResult } from '../types.js';
import {
  detectEol,
  joinLines,
  normalizeNewlines,
  splitLinesPreserveTrailing,
} from './diffEngine.js';

interface LineEditInterval {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
}

function extractLineEdits(baseLines: string[], targetLines: string[]): LineEditInterval[] {
  const parts = diffArrays(baseLines, targetLines);
  const edits: LineEditInterval[] = [];
  let baseCursor = 0;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      baseCursor += part.value.length;
      i += 1;
      continue;
    }

    const baseStart = baseCursor;
    const replacement: string[] = [];

    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const seg = parts[i];
      if (seg.removed) {
        baseCursor += seg.value.length;
      } else if (seg.added) {
        replacement.push(...seg.value);
      }
      i += 1;
    }

    edits.push({
      baseStart,
      baseEnd: baseCursor,
      replacement,
    });
  }

  return edits;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function editsEqual(a: LineEditInterval, b: LineEditInterval): boolean {
  return (
    a.baseStart === b.baseStart &&
    a.baseEnd === b.baseEnd &&
    arraysEqual(a.replacement, b.replacement)
  );
}

function intervalsOverlap(a: LineEditInterval, b: LineEditInterval): boolean {
  const aPureInsert = a.baseStart === a.baseEnd;
  const bPureInsert = b.baseStart === b.baseEnd;

  if (aPureInsert && bPureInsert) {
    return a.baseStart === b.baseStart;
  }
  if (aPureInsert) {
    return a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd;
  }
  if (bPureInsert) {
    return b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd;
  }
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/**
 * Deterministic line-level 3-way merge.
 * Returns `{ ok: false, conflict: true }` on overlapping non-identical edits.
 */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string
): MergeResult {
  const normBase = normalizeNewlines(base);
  const normOurs = normalizeNewlines(ours);
  const normTheirs = normalizeNewlines(theirs);

  if (normOurs === normBase) {
    return { ok: true, content: theirs };
  }
  if (normTheirs === normBase) {
    return { ok: true, content: ours };
  }
  if (normOurs === normTheirs) {
    return { ok: true, content: theirs };
  }

  const baseParsed = splitLinesPreserveTrailing(normBase);
  const oursParsed = splitLinesPreserveTrailing(normOurs);
  const theirsParsed = splitLinesPreserveTrailing(normTheirs);

  const oursEdits = extractLineEdits(baseParsed.lines, oursParsed.lines);
  const theirsEdits = extractLineEdits(baseParsed.lines, theirsParsed.lines);

  const mergedLines: string[] = [];
  let baseCursor = 0;
  let i = 0;
  let j = 0;

  while (i < oursEdits.length || j < theirsEdits.length) {
    const e1 = i < oursEdits.length ? oursEdits[i] : undefined;
    const e2 = j < theirsEdits.length ? theirsEdits[j] : undefined;

    if (e1 && e2) {
      if (editsEqual(e1, e2)) {
        if (e1.baseStart > baseCursor) {
          mergedLines.push(...baseParsed.lines.slice(baseCursor, e1.baseStart));
        }
        mergedLines.push(...e1.replacement);
        baseCursor = e1.baseEnd;
        i += 1;
        j += 1;
        continue;
      }

      if (intervalsOverlap(e1, e2)) {
        return {
          ok: false,
          conflict: true,
          reason: `Overlapping edits near line ${Math.min(e1.baseStart, e2.baseStart) + 1}`,
        };
      }

      if (e1.baseEnd <= e2.baseStart) {
        if (e1.baseStart > baseCursor) {
          mergedLines.push(...baseParsed.lines.slice(baseCursor, e1.baseStart));
        }
        mergedLines.push(...e1.replacement);
        baseCursor = e1.baseEnd;
        i += 1;
      } else {
        if (e2.baseStart > baseCursor) {
          mergedLines.push(...baseParsed.lines.slice(baseCursor, e2.baseStart));
        }
        mergedLines.push(...e2.replacement);
        baseCursor = e2.baseEnd;
        j += 1;
      }
      continue;
    }

    const remaining = e1 ?? e2!;
    if (remaining.baseStart > baseCursor) {
      mergedLines.push(...baseParsed.lines.slice(baseCursor, remaining.baseStart));
    }
    mergedLines.push(...remaining.replacement);
    baseCursor = remaining.baseEnd;
    if (e1) {
      i += 1;
    } else {
      j += 1;
    }
  }

  if (baseCursor < baseParsed.lines.length) {
    mergedLines.push(...baseParsed.lines.slice(baseCursor));
  }

  const oursTouchedEof =
    oursEdits.length > 0 &&
    oursEdits[oursEdits.length - 1].baseEnd === baseParsed.lines.length;
  const theirsTouchedEof =
    theirsEdits.length > 0 &&
    theirsEdits[theirsEdits.length - 1].baseEnd === baseParsed.lines.length;

  const hasTrailing =
    oursTouchedEof && !theirsTouchedEof
      ? oursParsed.hasTrailingNewline
      : theirsParsed.hasTrailingNewline;
  const eol = detectEol(theirs.length > 0 ? theirs : ours);

  return {
    ok: true,
    content: joinLines(mergedLines, hasTrailing, eol),
  };
}
