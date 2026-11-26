import { describe, expect, it } from 'vitest';
import {
  isBinaryBuffer,
  isOversized,
  isPathIgnoredByDefault,
  matchesGlobPattern,
  toPosixRelative,
} from '../src/baseline/noiseFilter.js';
import { ReviewStore } from '../src/baseline/reviewStore.js';

describe('noiseFilter', () => {
  it('normalizes relative paths and rejects paths outside workspace', () => {
    const root = process.platform === 'win32' ? 'D:\\Projects\\app' : '/projects/app';
    const inside =
      process.platform === 'win32'
        ? 'd:\\Projects\\app\\src\\index.ts'
        : '/projects/app/src/index.ts';
    const outside =
      process.platform === 'win32'
        ? 'D:\\Projects\\other\\index.ts'
        : '/projects/other/index.ts';

    expect(toPosixRelative(root, inside)).toBe('src/index.ts');
    expect(toPosixRelative(root, outside)).toBeNull();
    expect(toPosixRelative(root, root)).toBeNull();
  });

  it('filters default ignored directories, binary extensions, and custom globs', () => {
    expect(isPathIgnoredByDefault('.git/HEAD')).toBe(true);
    expect(isPathIgnoredByDefault('node_modules/diff/index.js')).toBe(true);
    expect(isPathIgnoredByDefault('dist/extension.js')).toBe(true);
    expect(isPathIgnoredByDefault('assets/logo.png')).toBe(true);
    expect(isPathIgnoredByDefault('src/index.ts')).toBe(false);

    expect(matchesGlobPattern('src/generated/api.ts', 'src/generated/**')).toBe(true);
    expect(matchesGlobPattern('foo/bar.snap', '*.snap')).toBe(true);
    expect(
      isPathIgnoredByDefault('src/generated/api.ts', ['src/generated/**'])
    ).toBe(true);
  });

  it('detects binary NUL bytes and oversized files', () => {
    expect(isBinaryBuffer(new Uint8Array([65, 66, 67, 10]))).toBe(false);
    expect(isBinaryBuffer(new Uint8Array([65, 0, 67]))).toBe(true);
    expect(isOversized(2048 * 1024 + 1, 2048)).toBe(true);
    expect(isOversized(1024, 2048)).toBe(false);
  });
});

describe('ReviewStore', () => {
  it('accumulates multi-round agent edits against original pre-agent baseline', () => {
    const store = new ReviewStore();
    store.setCleanBaseline('src/a.ts', 'v0\n');

    expect(
      store.recordExternalModification('src/a.ts', '/repo/src/a.ts', 'v1\n', null, 100)
    ).toBe('added');
    expect(store.getPending('src/a.ts')?.baselineContent).toBe('v0\n');

    // Second round of edits by agent keeps v0 baseline!
    expect(
      store.recordExternalModification('src/a.ts', '/repo/src/a.ts', 'v2\n', null, 200)
    ).toBe('updated');
    expect(store.getPending('src/a.ts')?.baselineContent).toBe('v0\n');

    // External revert back to v0 auto-resolves pending entry
    expect(
      store.recordExternalModification('src/a.ts', '/repo/src/a.ts', 'v0\n', null, 300)
    ).toBe('resolved');
    expect(store.hasPending('src/a.ts')).toBe(false);
  });

  it('auto-resolves created+deleted and deleted+identically-recreated files', () => {
    const store = new ReviewStore();

    expect(
      store.recordExternalCreation('src/new.ts', '/repo/src/new.ts', 'abc\n', 100)
    ).toBe('added');
    expect(store.getPending('src/new.ts')?.kind).toBe('created');

    // Agent deletes the file it just created -> net zero
    expect(
      store.recordExternalDeletion('src/new.ts', '/repo/src/new.ts', null, 200)
    ).toBe('resolved');
    expect(store.hasPending('src/new.ts')).toBe(false);

    // Tracked file deleted, then recreated with different content -> becomes modified
    store.setCleanBaseline('src/old.ts', 'orig\n');
    expect(
      store.recordExternalDeletion('src/old.ts', '/repo/src/old.ts', null, 300)
    ).toBe('added');
    expect(store.getPending('src/old.ts')?.kind).toBe('deleted');

    expect(
      store.recordExternalCreation('src/old.ts', '/repo/src/old.ts', 'changed\n', 400)
    ).toBe('updated');
    expect(store.getPending('src/old.ts')).toMatchObject({
      kind: 'modified',
      baselineContent: 'orig\n',
    });
  });

  it('serializes and hydrates persisted state cleanly', () => {
    const store = new ReviewStore();
    store.setCleanBaseline('clean.ts', 'clean\n');
    store.recordExternalModification(
      'dirty.ts',
      '/repo/dirty.ts',
      'after\n',
      'before\n',
      500
    );

    const snapshot = store.serialize();
    const restored = new ReviewStore();
    restored.hydrate(snapshot);

    expect(restored.getCleanBaseline('clean.ts')).toBe('clean\n');
    expect(restored.getPending('dirty.ts')).toMatchObject({
      relativePath: 'dirty.ts',
      kind: 'modified',
      baselineContent: 'before\n',
    });
  });
});
