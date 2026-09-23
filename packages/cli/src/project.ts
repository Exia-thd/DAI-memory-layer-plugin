import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { locateStore, storeDirFor, MemoryStore, readMeta, type Hunk } from '@memory-layer/core';

export interface ProjectInfo {
  root: string;
  name: string;
  remoteUrl: string | null;
  branch: string | null;
  lastCommit: string | null;
}

/**
 * Every git invocation checks its exit status.
 *
 * A subprocess whose result is never inspected is how an index ends up with one
 * node and no edges while every command reports success.
 *
 * The buffer is sized for the output, not for the default. `execFileSync` gives
 * a child 1 MB and throws ENOBUFS past it, which lands in the same `catch` as a
 * bad ref -- so a large diff was reported as "could not read changes from git",
 * and a branch that changed a few hundred files could not be reviewed at all.
 * A `git diff --unified=0` of 287 files is already 3.4 MB.
 */
const GIT_OUTPUT_LIMIT = 512 * 1024 * 1024;

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_OUTPUT_LIMIT,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Which files the working tree has changed, relative to the repository root.
 *
 * Three scopes, because the useful question changes with the moment: what is
 * about to be committed, everything touched since the last commit, or how this
 * branch differs from where it started.
 */
export function changedFiles(root: string, scope: 'staged' | 'working' | 'compare', baseRef?: string): string[] | null {
  const args =
    scope === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : scope === 'compare'
        ? ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef ?? 'HEAD'}...HEAD`]
        : ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'];

  const out = git(args, root);
  // null means git itself failed -- an unborn branch, a bad ref, not a repo.
  // That is not the same as "nothing changed", and the caller must not read it
  // as an all-clear.
  if (out === null) return null;

  const tracked = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (scope !== 'working') return unique(tracked);

  // Untracked files carry no history, so a decision recorded against one is the
  // only record that exists. Leaving them out is exactly the wrong bias.
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root) ?? '';
  return unique([...tracked, ...untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)]);
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/** Resolves the project from a directory, refusing to guess when it is not a repo. */
export function resolveProject(from: string = process.cwd()): ProjectInfo {
  const root = git(['rev-parse', '--show-toplevel'], from);
  if (!root) {
    throw new Error(
      `${from} is not inside a git repository. Memory is scoped to a repository; ` +
        `run this from one rather than having a directory guessed for you.`,
    );
  }
  const resolved = path.resolve(root);
  return {
    root: resolved,
    name: path.basename(resolved),
    remoteUrl: git(['remote', 'get-url', 'origin'], resolved),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], resolved),
    lastCommit: git(['rev-parse', 'HEAD'], resolved),
  };
}

export function currentCommit(root: string): string | null {
  return git(['rev-parse', 'HEAD'], root);
}

/** Opens the nearest store. Read-only handles take a shared lock and never block a writer. */
export async function openStore(options: { readOnly?: boolean; from?: string } = {}): Promise<MemoryStore> {
  const from = options.from ?? process.cwd();
  const dir = locateStore(from);
  if (!dir) {
    throw new Error(`No memory store found at or above ${from}. Run \`dai-memory init\` first.`);
  }
  return new MemoryStore(dir, { readOnly: options.readOnly ?? false });
}

export function storeDirOrThrow(from: string = process.cwd()): string {
  const dir = locateStore(from);
  if (!dir) throw new Error(`No memory store found at or above ${from}. Run \`dai-memory init\` first.`);
  return dir;
}

const execFileAsync = promisify(execFile);

/**
 * The async twin of `git`, for checking many repositories at once.
 *
 * Each check spawns a process, so doing them one after another costs the sum of
 * all of them: a registry with a couple of hundred projects turns a listing into
 * a minute of waiting. Parallel with a cap keeps it flat without forking the
 * whole registry at once.
 */
async function gitAsync(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_OUTPUT_LIMIT });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface Staleness {
  stale: boolean;
  indexed: string | null;
  head: string | null;
  /** Set when the check could not run at all -- a moved or deleted repository. */
  unavailable?: string;
}

/** Staleness for one store, never throwing: a broken entry must not sink a listing. */
export async function isStaleAsync(storeDir: string): Promise<Staleness> {
  try {
    const meta = readMeta(storeDir);
    if (!fs.existsSync(meta.projectRoot)) {
      return { stale: false, indexed: meta.lastCommit ?? null, head: null, unavailable: 'project directory is gone' };
    }
    const head = await gitAsync(['rev-parse', 'HEAD'], meta.projectRoot);
    if (!head) {
      return { stale: false, indexed: meta.lastCommit ?? null, head: null, unavailable: 'not a git repository any more' };
    }
    return { stale: Boolean(meta.lastCommit && head !== meta.lastCommit), indexed: meta.lastCommit ?? null, head };
  } catch (err) {
    return {
      stale: false, indexed: null, head: null,
      unavailable: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
}

/** True when the store was built against a commit that is no longer HEAD. */
export function isStale(storeDir: string): { stale: boolean; indexed: string | null; head: string | null } {
  const meta = readMeta(storeDir);
  const head = currentCommit(meta.projectRoot);
  return { stale: Boolean(head && meta.lastCommit && head !== meta.lastCommit), indexed: meta.lastCommit ?? null, head };
}

export function ensureGitignore(root: string, entry: string): void {
  const file = path.join(root, '.gitignore');
  const line = `${entry}/`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line || l.trim() === entry)) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}\n# Local memory store (binary, machine-specific)\n${line}\n`);
}

export { storeDirFor };

/**
 * The changed line ranges, not just which files changed.
 *
 * `--unified=0` so a hunk covers the changed lines and nothing around them:
 * three lines of context either side would attribute a change to whatever
 * declaration happens to sit next to it. Rename detection is on, and a rename
 * with edits reports the edits against the new path.
 *
 * Null, as everywhere else here, means git failed -- which must never be read
 * as "nothing changed".
 */
export function changedHunks(
  root: string,
  scope: 'staged' | 'working' | 'compare',
  baseRef?: string,
): Hunk[] | null {
  const range =
    scope === 'staged' ? ['--cached']
      : scope === 'compare' ? [`${baseRef ?? 'HEAD'}...HEAD`]
        : ['HEAD'];
  const out = git(['diff', '--unified=0', '--find-renames', '--no-color', ...range], root);
  if (out === null) return null;
  return parseHunks(out);
}

const STATUS_BY_PREFIX: Record<string, Hunk['status']> = {
  'new file': 'added',
  'deleted file': 'deleted',
  'rename to': 'renamed',
};

/** `git diff --unified=0` output, as hunks. Exported for its own tests. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let status: Hunk['status'] = 'modified';

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      // Take the b/ path: for a rename it is where the code lives now.
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = match ? match[2]! : null;
      status = 'modified';
      continue;
    }
    for (const [prefix, value] of Object.entries(STATUS_BY_PREFIX)) {
      if (line.startsWith(prefix)) status = value;
    }
    if (!line.startsWith('@@') || !file) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    hunks.push({
      file,
      status,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

/**
 * Who has committed to each of these files, most recent 100 commits.
 *
 * History, not judgement: it says who has worked here, and the answer that uses
 * it has to say the same.
 */
export function fileAuthors(root: string, files: string[]): Map<string, Array<{ name: string; commits: number }>> {
  const byFile = new Map<string, Array<{ name: string; commits: number }>>();
  for (const file of files) {
    const out = git(['log', '-n', '100', '--format=%an', '--', file], root);
    if (out === null || out === '') continue;
    const counts = new Map<string, number>();
    for (const name of out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    byFile.set(file, [...counts].map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits));
  }
  return byFile;
}
