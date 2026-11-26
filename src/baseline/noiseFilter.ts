import * as path from 'node:path';

export const DEFAULT_IGNORED_SEGMENTS = new Set<string>([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.vscode-test',
]);

export const BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
  '.vsix',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.sqlite',
  '.db',
  '.lockb',
  '.class',
  '.jar',
  '.pyc',
]);

export function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function toPosixRelative(workspaceRoot: string, fsPath: string): string | null {
  const normRoot = path.resolve(workspaceRoot);
  const normTarget = path.resolve(fsPath);

  const rootCmp = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  const targetCmp = process.platform === 'win32' ? normTarget.toLowerCase() : normTarget;

  if (targetCmp === rootCmp) {
    return null;
  }

  const sep = path.sep;
  if (!targetCmp.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep)) {
    return null;
  }

  const rel = path.relative(normRoot, normTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  return normalizePosixPath(rel);
}

function globToRegExp(pattern: string): RegExp {
  const norm = normalizePosixPath(pattern.trim());
  let regexStr = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
          continue;
        }
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(ch)) {
      regexStr += '\\' + ch;
    } else {
      regexStr += ch;
    }
    i += 1;
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function matchesGlobPattern(relativePath: string, pattern: string): boolean {
  const normPath = normalizePosixPath(relativePath);
  const normPat = normalizePosixPath(pattern.trim());
  if (!normPat) {
    return false;
  }
  const hasSlash = normPat.includes('/');
  const regex = globToRegExp(normPat);
  if (hasSlash) {
    return regex.test(normPath);
  }
  const segments = normPath.split('/');
  return regex.test(normPath) || segments.some((seg) => regex.test(seg));
}

export function isPathIgnoredByDefault(
  relativePath: string,
  extraPatterns: string[] = []
): boolean {
  const norm = normalizePosixPath(relativePath);
  if (!norm) {
    return true;
  }

  const segments = norm.split('/');
  for (const seg of segments) {
    if (DEFAULT_IGNORED_SEGMENTS.has(seg)) {
      return true;
    }
  }

  const ext = path.posix.extname(norm).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  for (const pattern of extraPatterns) {
    if (matchesGlobPattern(norm, pattern)) {
      return true;
    }
  }

  return false;
}

export function isBinaryBuffer(buf: Uint8Array): boolean {
  const inspectLen = Math.min(buf.length, 8192);
  for (let i = 0; i < inspectLen; i += 1) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

export function isOversized(byteLength: number, maxFileSizeKB: number): boolean {
  return byteLength > maxFileSizeKB * 1024;
}
