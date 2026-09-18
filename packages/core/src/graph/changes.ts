import type { CodeIndex, SymbolRef, RiskLevel } from './code.js';
import { impact, symbolRef, isTestPath } from './code.js';
import type { ProcessIndex } from './process.js';
import { processesFor } from './process.js';

/**
 * What a diff actually changes, in terms of declarations rather than lines.
 *
 * A diff says "eleven lines in four files". The question before a commit is a
 * different one: which declarations did those lines belong to, what depends on
 * them, which execution flows run through them, and how much of that is
 * dangerous. This turns the first into the second.
 *
 * The mapping is from the **old** side of the diff onto the indexed graph,
 * because the graph was built from the committed tree: those line numbers and
 * the index agree. Lines added by the diff describe code the index has not seen
 * yet; they are counted and reported as such rather than silently matched
 * against stale positions. Git is not called from here -- hunks come in as
 * data, so this is testable without a repository.
 */

export interface Hunk {
  /** Repository-relative, forward slashes. */
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The range this hunk replaced, in the committed file. Zero lines means a pure insertion. */
  oldStart: number;
  oldLines: number;
  /** The range it became, in the working file. */
  newStart: number;
  newLines: number;
}

export interface ChangedSymbol extends SymbolRef {
  /** Whether the whole declaration went, or part of it changed. */
  change: 'removed' | 'modified';
  /** The lines of this declaration the diff touched. */
  touched: Array<{ start: number; end: number }>;
  dependents: {
    total: number;
    direct: SymbolRef[];
    /** Dependents outside this declaration's own file: the ones a diff cannot show. */
    external: number;
    risk: RiskLevel;
    reasons: string[];
  };
  processes: Array<{ id: string; name: string; filePath: string; depth: number | null }>;
}

export interface ChangedFile {
  file: string;
  status: Hunk['status'];
  symbols: string[];
  /** Hunks that matched no indexed declaration: new code, or code the index has not seen. */
  unmatchedHunks: number;
  /** True when the file itself is not in the code graph at all. */
  unindexed: boolean;
  isTest: boolean;
}

export interface DetectChangesResult {
  status: 'ok';
  scope: string;
  files: ChangedFile[];
  symbols: ChangedSymbol[];
  processes: Array<{ id: string; name: string; filePath: string; depth: number | null }>;
  summary: {
    files: number;
    symbols: number;
    removed: number;
    processes: number;
    risk: RiskLevel;
    reasons: string[];
    unmatchedHunks: number;
    unindexedFiles: number;
    testFiles: number;
  };
  /** What this answer could not see, said out loud rather than left to be assumed. */
  limits: string[];
}

const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function worst(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (highest, level) => (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest) ? level : highest),
    'LOW',
  );
}

function overlaps(start: number, end: number, hunk: Hunk): boolean {
  // A pure insertion has no old lines: it sits between oldStart and oldStart+1,
  // and belongs to the declaration that contains that seam.
  const hunkStart = hunk.oldStart;
  const hunkEnd = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldLines - 1;
  return hunkStart <= end && hunkEnd >= start;
}

export interface DetectChangesOptions {
  /** How far to look for dependents of each changed declaration. */
  maxDepth?: number;
  includeTests?: boolean;
  processes?: ProcessIndex;
  /** Files the index does not contain, so the answer can say so. */
  indexedFiles?: Set<string>;
}

/**
 * Which declarations a set of hunks changes, and what that reaches.
 *
 * A declaration whose whole range is inside a deleted file, or covered by a
 * hunk that replaced it with nothing, is reported as removed -- the case that
 * breaks callers rather than merely changing behaviour.
 */
export function detectChanges(
  index: CodeIndex,
  hunks: Hunk[],
  scope: string,
  options: DetectChangesOptions = {},
): DetectChangesResult {
  const maxDepth = Math.max(1, Math.min(3, Math.floor(options.maxDepth ?? 2)));
  const includeTests = options.includeTests ?? false;

  const byFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    const list = byFile.get(hunk.file);
    if (list) list.push(hunk);
    else byFile.set(hunk.file, [hunk]);
  }

  // Indexed declarations, by file, so each file is scanned once.
  const symbolsByFile = new Map<string, string[]>();
  for (const [id, symbol] of index.symbols) {
    const list = symbolsByFile.get(symbol.filePath);
    if (list) list.push(id);
    else symbolsByFile.set(symbol.filePath, [id]);
  }

  const files: ChangedFile[] = [];
  const changed: ChangedSymbol[] = [];
  const touchedBySymbol = new Map<string, Array<{ start: number; end: number }>>();
  const removedIds = new Set<string>();

  for (const [file, fileHunks] of byFile) {
    const candidates = symbolsByFile.get(file) ?? [];
    const matchedHunks = new Set<Hunk>();
    const inFile: string[] = [];

    for (const id of candidates) {
      const symbol = index.symbols.get(id)!;
      const hits = fileHunks.filter((hunk) => overlaps(symbol.startLine, symbol.endLine, hunk));
      if (hits.length === 0) continue;
      for (const hunk of hits) matchedHunks.add(hunk);
      inFile.push(id);
      touchedBySymbol.set(
        id,
        hits.map((hunk) => ({
          start: Math.max(symbol.startLine, hunk.oldStart),
          end: Math.min(symbol.endLine, hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldLines - 1),
        })),
      );
      const deletedFile = fileHunks.every((hunk) => hunk.status === 'deleted');
      const swallowed = hits.some((hunk) =>
        hunk.oldStart <= symbol.startLine
        && hunk.oldStart + hunk.oldLines - 1 >= symbol.endLine
        && hunk.newLines === 0);
      if (deletedFile || swallowed) removedIds.add(id);
    }

    files.push({
      file,
      status: fileHunks[0]!.status,
      symbols: inFile,
      unmatchedHunks: fileHunks.filter((hunk) => !matchedHunks.has(hunk)).length,
      unindexed: !(options.indexedFiles ? options.indexedFiles.has(file) : symbolsByFile.has(file)),
      isTest: isTestPath(file),
    });
  }

  for (const [id, touched] of touchedBySymbol) {
    const symbol = index.symbols.get(id)!;
    if (!includeTests && isTestPath(symbol.filePath)) continue;
    const blast = impact(index, id, { direction: 'upstream', maxDepth, includeTests });
    const direct = (blast.byDepth[1] ?? []).map((hit) => symbolRef(index, hit.id));
    changed.push({
      ...symbolRef(index, id),
      change: removedIds.has(id) ? 'removed' : 'modified',
      touched,
      dependents: {
        total: blast.summary.symbols,
        direct,
        external: direct.filter((ref) => ref.filePath !== symbol.filePath).length,
        risk: blast.summary.risk,
        reasons: blast.summary.reasons,
      },
      processes: options.processes
        ? processesFor(options.processes, [id]).map(({ id: pid, name, filePath, depth }) => ({ id: pid, name, filePath, depth }))
        : [],
    });
  }

  changed.sort((a, b) =>
    Number(b.change === 'removed') - Number(a.change === 'removed')
    || b.dependents.total - a.dependents.total
    || a.filePath.localeCompare(b.filePath));

  const flows = new Map<string, { id: string; name: string; filePath: string; depth: number | null }>();
  for (const symbol of changed) {
    for (const process of symbol.processes) if (!flows.has(process.id)) flows.set(process.id, process);
  }

  const removed = changed.filter((symbol) => symbol.change === 'removed');
  const reasons: string[] = [];
  let risk = worst(changed.map((symbol) => symbol.dependents.risk));
  reasons.push(`${changed.length} declaration(s) changed in ${files.length} file(s)`);
  if (removed.length > 0) {
    const breaking = removed.filter((symbol) => symbol.dependents.total > 0);
    if (breaking.length > 0) {
      risk = 'CRITICAL';
      reasons.push(`${breaking.length} removed declaration(s) still have dependents: ${breaking.slice(0, 3).map((symbol) => symbol.qualified).join(', ')}`);
    } else {
      reasons.push(`${removed.length} declaration(s) removed, nothing depends on them`);
    }
  }

  const unmatched = files.reduce((sum, file) => sum + file.unmatchedHunks, 0);
  const unindexed = files.filter((file) => file.unindexed).length;
  const limits: string[] = [
    'Changed declarations are matched against the indexed tree, so added code is counted but not analysed until the next ingest.',
  ];
  if (unmatched > 0) {
    limits.push(`${unmatched} hunk(s) matched no indexed declaration: new code, or code the index has not seen.`);
  }
  if (unindexed > 0) {
    limits.push(`${unindexed} changed file(s) are not in the code graph at all.`);
  }
  if (!options.processes) {
    limits.push('Execution flows were not built for this answer, so none are listed.');
  }

  return {
    status: 'ok',
    scope,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    symbols: changed,
    processes: [...flows.values()],
    summary: {
      files: files.length,
      symbols: changed.length,
      removed: removed.length,
      processes: flows.size,
      risk,
      reasons,
      unmatchedHunks: unmatched,
      unindexedFiles: unindexed,
      testFiles: files.filter((file) => file.isTest).length,
    },
    limits,
  };
}

// ---------------------------------------------------------------------------
// review

export interface ReviewResult {
  status: 'ok';
  base: string;
  changes: DetectChangesResult;
  /** Changes that can break code outside the file they were made in. */
  breaking: Array<{
    symbol: SymbolRef;
    change: ChangedSymbol['change'];
    reason: string;
    dependents: SymbolRef[];
  }>;
  modules: Array<{ module: string; files: number; symbols: number }>;
  reviewers: Array<{ name: string; commits: number; files: number }>;
  summary: {
    risk: RiskLevel;
    breaking: number;
    modules: number;
    /** Where the reviewer suggestion came from, so nobody reads it as judgement. */
    reviewersFrom: string;
  };
}

export interface ReviewOptions {
  /** Per changed file, who has committed to it: name -> commits. From git history. */
  history?: Map<string, Array<{ name: string; commits: number }>>;
}

/** The module a path belongs to: its first two segments, or its directory. */
export function moduleOf(file: string): string {
  const parts = file.split('/');
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/**
 * A change set as a reviewer would want it: what can break, where it lands, and
 * who has worked there before.
 *
 * Reviewers are read from git history alone. It says who has touched these
 * files, which is not the same as who should look at them, and the answer says
 * so rather than presenting a name as a recommendation.
 */
export function review(changes: DetectChangesResult, base: string, options: ReviewOptions = {}): ReviewResult {
  const breaking: ReviewResult['breaking'] = [];
  for (const symbol of changes.symbols) {
    const external = symbol.dependents.direct.filter((ref) => ref.filePath !== symbol.filePath);
    if (symbol.change === 'removed' && symbol.dependents.total > 0) {
      breaking.push({
        symbol,
        change: symbol.change,
        reason: `removed, and ${symbol.dependents.total} declaration(s) still depend on it`,
        dependents: symbol.dependents.direct,
      });
    } else if (external.length > 0) {
      breaking.push({
        symbol,
        change: symbol.change,
        reason: `changed, and ${external.length} caller(s) in other files depend on it`,
        dependents: external,
      });
    }
  }
  breaking.sort((a, b) => b.dependents.length - a.dependents.length);

  const modules = new Map<string, { files: number; symbols: number }>();
  for (const file of changes.files) {
    const key = moduleOf(file.file);
    const entry = modules.get(key) ?? { files: 0, symbols: 0 };
    entry.files += 1;
    entry.symbols += file.symbols.length;
    modules.set(key, entry);
  }

  const reviewers = new Map<string, { commits: number; files: number }>();
  for (const [, authors] of options.history ?? new Map()) {
    for (const author of authors) {
      const entry = reviewers.get(author.name) ?? { commits: 0, files: 0 };
      entry.commits += author.commits;
      entry.files += 1;
      reviewers.set(author.name, entry);
    }
  }

  return {
    status: 'ok',
    base,
    changes,
    breaking,
    modules: [...modules].map(([module, counts]) => ({ module, ...counts }))
      .sort((a, b) => b.symbols - a.symbols || b.files - a.files || a.module.localeCompare(b.module)),
    reviewers: [...reviewers].map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.files - a.files || b.commits - a.commits || a.name.localeCompare(b.name))
      .slice(0, 5),
    summary: {
      risk: changes.summary.risk,
      breaking: breaking.length,
      modules: modules.size,
      reviewersFrom: 'git history of the changed files: who has committed to them, not who should review them',
    },
  };
}
