import { execFile } from 'node:child_process';
import { normalizePosixPath } from '../baseline/noiseFilter.js';

export interface GitDirtyEntry {
  relativePath: string;
  status: string;
}

export class GitService {
  constructor(private readonly workspaceRoot: string) {}

  private runGit(args: string[], stdinText?: string): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd: this.workspaceRoot,
          maxBuffer: 25 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, stdout: stdout ?? '' });
            return;
          }
          resolve({ ok: true, stdout: stdout ?? '' });
        }
      );

      if (stdinText !== undefined && child.stdin) {
        child.stdin.write(stdinText);
        child.stdin.end();
      }
    });
  }

  async isGitRepo(): Promise<boolean> {
    const res = await this.runGit(['rev-parse', '--is-inside-work-tree']);
    return res.ok && res.stdout.trim() === 'true';
  }

  async getDirtyFiles(): Promise<GitDirtyEntry[]> {
    const res = await this.runGit(['status', '--porcelain', '-z', '-uall']);
    if (!res.ok || !res.stdout) {
      return [];
    }

    const parts = res.stdout.split('\0');
    const entries: GitDirtyEntry[] = [];
    let i = 0;

    while (i < parts.length) {
      const raw = parts[i];
      i += 1;
      if (!raw || raw.length < 4) {
        continue;
      }

      const status = raw.slice(0, 2);
      const filePath = normalizePosixPath(raw.slice(3));

      // Renames & copies include an extra NUL-terminated source path entry.
      if (status.includes('R') || status.includes('C')) {
        i += 1;
      }

      if (!filePath || filePath.endsWith('/')) {
        continue;
      }

      entries.push({ relativePath: filePath, status });
    }

    return entries;
  }

  async getIndexOrHeadContent(relativePath: string): Promise<string | null> {
    const posix = normalizePosixPath(relativePath);
    const indexRes = await this.runGit(['show', `:${posix}`]);
    if (indexRes.ok) {
      return indexRes.stdout;
    }
    return this.getHeadContent(posix);
  }

  async getHeadContent(relativePath: string): Promise<string | null> {
    const posix = normalizePosixPath(relativePath);
    const headRes = await this.runGit(['show', `HEAD:${posix}`]);
    if (headRes.ok) {
      return headRes.stdout;
    }
    return null;
  }

  async checkIgnored(relativePaths: string[]): Promise<Set<string>> {
    if (relativePaths.length === 0) {
      return new Set();
    }
    const input = relativePaths.map(normalizePosixPath).join('\0') + '\0';
    const res = await this.runGit(['check-ignore', '--stdin', '-z'], input);
    if (!res.stdout) {
      return new Set();
    }
    const ignored = new Set<string>();
    for (const item of res.stdout.split('\0')) {
      if (item) {
        ignored.add(normalizePosixPath(item));
      }
    }
    return ignored;
  }
}
