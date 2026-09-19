import {
  MemoryStore, loadCodeIndex, resolveTarget, impact, symbolContext, trace,
  buildProcesses, resolveProcess, query, detectChanges, review, planRename, applyRename,
  check, codeClusters, readOnlyCypher, readMeta,
  routeMap, shapeCheck, apiImpact, toolMap, taint, explain, pdg,
  type TargetQuery, type ImpactOptions, type ImpactResult, type ContextResult,
  type TraceResult, type TraceOptions, type Resolution, type CodeIndex, type SymbolRef,
  type ProcessIndex, type Process, type QueryResult,
  type DetectChangesResult, type ReviewResult, type RenamePlan, type RenameRefusal,
  type CheckResult, type CodeCluster,
  type RouteMap, type ShapeCheckResult, type ApiImpactResult, type ToolMap,
  type TaintResult, type ExplainResult, type PdgResult, type PdgFailure,
} from '@memory-layer/core';
import { storeDirOrThrow, resolveProject, changedHunks, fileAuthors, isStale } from './project.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Impact, context and trace, for the CLI and the MCP server alike.
 *
 * A target that names nothing, or names several things, is answered as such:
 * `not_found` with the closest names, or `ambiguous` with every candidate
 * ranked. Neither is an empty answer, and neither is a guess.
 */

export type Unresolved =
  | { status: 'not_found'; role: string; query: TargetQuery; suggestions: SymbolRef[] }
  | { status: 'ambiguous'; role: string; query: TargetQuery; candidates: Array<SymbolRef & { degree: number }> };

function unresolved(role: string, query: TargetQuery, resolution: Resolution): Unresolved | null {
  if (resolution.status === 'ok') return null;
  return resolution.status === 'ambiguous'
    ? { status: 'ambiguous', role, query, candidates: resolution.candidates }
    : { status: 'not_found', role, query, suggestions: resolution.suggestions };
}

async function withIndex<T>(from: string | undefined, work: (store: MemoryStore, index: CodeIndex) => Promise<T>): Promise<T> {
  const store = new MemoryStore(storeDirOrThrow(from), { readOnly: true });
  try {
    if (!store.graphReady) {
      throw new Error('This store has no code graph yet. Run `dai-memory init` to build it.');
    }
    return await work(store, await loadCodeIndex(store));
  } finally {
    await store.close();
  }
}

/**
 * Flows are built unless they were turned off. They cost one forward walk per
 * entry point over an index that is already in memory, and an impact answer
 * that cannot say which flows run through a change is the answer the harness
 * most often needs.
 */
function flowsFor(index: CodeIndex, options: { flows?: boolean; includeTests?: boolean }): ProcessIndex | undefined {
  if (options.flows === false) return undefined;
  return buildProcesses(index, { includeTests: options.includeTests });
}

export async function runImpact(
  target: TargetQuery,
  options: ImpactOptions & { from?: string; flows?: boolean } = {},
): Promise<ImpactResult | Unresolved> {
  return withIndex(options.from, async (_store, index) => {
    const resolution = resolveTarget(index, target);
    return unresolved('target', target, resolution)
      ?? impact(index, (resolution as { id: string }).id, { ...options, processes: flowsFor(index, options) });
  });
}

export async function runContext(
  target: TargetQuery,
  options: { from?: string; flows?: boolean } = {},
): Promise<ContextResult | Unresolved> {
  return withIndex(options.from, async (store, index) => {
    const resolution = resolveTarget(index, target);
    return unresolved('target', target, resolution)
      ?? symbolContext(store, index, (resolution as { id: string }).id, flowsFor(index, options));
  });
}

export interface ProcessListResult {
  status: 'ok';
  processes: Array<{ id: string; name: string; filePath: string; startLine: number; steps: number; depth: number; truncated: boolean }>;
  summary: { entryPoints: number; processes: number; shown: number; truncated: boolean; rule: string };
}

export async function runProcesses(
  options: { from?: string; limit?: number; includeTests?: boolean } = {},
): Promise<ProcessListResult> {
  return withIndex(options.from, async (_store, index) => {
    const flows = buildProcesses(index, { includeTests: options.includeTests });
    const limit = Math.max(1, Math.floor(options.limit ?? 30));
    return {
      status: 'ok' as const,
      processes: flows.processes.slice(0, limit).map((process) => ({
        id: process.id,
        name: process.name,
        filePath: process.entry.filePath,
        startLine: process.entry.startLine,
        steps: process.steps.length,
        depth: process.depth,
        truncated: process.truncated,
      })),
      summary: {
        entryPoints: flows.entryPoints,
        processes: flows.processes.length,
        shown: Math.min(limit, flows.processes.length),
        truncated: flows.truncated,
        rule: 'an entry point is a declaration nothing in this repository calls, which calls other declarations',
      },
    };
  });
}

export type ProcessUnresolved =
  | { status: 'not_found'; role: 'process'; asked: string; suggestions: Array<{ id: string; name: string; filePath: string; steps: number }> }
  | { status: 'ambiguous'; role: 'process'; asked: string; candidates: Array<{ id: string; name: string; filePath: string; steps: number }> };

export async function runProcess(
  name: string,
  options: { from?: string; includeTests?: boolean } = {},
): Promise<(Process & { status: 'ok' }) | ProcessUnresolved> {
  return withIndex(options.from, async (_store, index) => {
    const flows = buildProcesses(index, { includeTests: options.includeTests });
    const resolution = resolveProcess(flows, name);
    if (resolution.status === 'ambiguous') {
      return { status: 'ambiguous' as const, role: 'process' as const, asked: name, candidates: resolution.candidates };
    }
    if (resolution.status === 'not_found') {
      return { status: 'not_found' as const, role: 'process' as const, asked: name, suggestions: resolution.suggestions };
    }
    return { status: 'ok' as const, ...flows.byId.get(resolution.id)! };
  });
}

export async function runQuery(
  text: string,
  options: { from?: string; limit?: number; includeTests?: boolean } = {},
): Promise<QueryResult> {
  return withIndex(options.from, async (store, index) => {
    const flows = buildProcesses(index, { includeTests: options.includeTests });
    return query(store, index, flows, text, { limit: options.limit, includeTests: options.includeTests });
  });
}

export async function runTrace(
  fromQuery: TargetQuery,
  toQuery: TargetQuery,
  options: TraceOptions & { from?: string } = {},
): Promise<TraceResult | Unresolved> {
  return withIndex(options.from, async (_store, index) => {
    const start = resolveTarget(index, fromQuery);
    const end = resolveTarget(index, toQuery);
    return unresolved('from', fromQuery, start)
      ?? unresolved('to', toQuery, end)
      ?? trace(index, (start as { id: string }).id, (end as { id: string }).id, options);
  });
}

// ---------------------------------------------------------------------------
// text

const where = (ref: SymbolRef, line?: number) => `${ref.filePath}:${line && line > 0 ? line : ref.startLine}`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

export function formatUnresolved(result: Unresolved): string {
  const asked = result.query.uid ?? result.query.name ?? '';
  if (result.status === 'not_found') {
    const lines = [`no declaration named ${JSON.stringify(asked)} (${result.role})`];
    if (result.suggestions.length > 0) {
      lines.push('did you mean:');
      for (const ref of result.suggestions) lines.push(`  ${ref.qualified}  ${where(ref)}`);
    }
    return lines.join('\n');
  }
  const lines = [`${JSON.stringify(asked)} (${result.role}) names ${result.candidates.length} declarations -- say which:`];
  for (const ref of result.candidates) {
    lines.push(`  ${ref.qualified}  ${where(ref)}  (${ref.degree} edges)   --uid ${ref.id.slice('Symbol:'.length)}`);
  }
  return lines.join('\n');
}

export function formatImpact(result: ImpactResult): string {
  const lines = [
    `${result.direction} impact of ${result.target.qualified}  ${where(result.target)}`,
    '',
  ];
  const depths = Object.keys(result.byDepth).map(Number).sort((a, b) => a - b);
  if (depths.length === 0) lines.push('nothing reaches it within the depth asked');
  for (const depth of depths) {
    lines.push(`d=${depth} (${result.labels[depth]}):`);
    for (const hit of result.byDepth[depth]!) {
      lines.push(`  - ${hit.qualified}  ${where(hit, hit.line)}  [${hit.via}, ${percent(hit.confidence)}]`);
    }
  }
  if (result.files.length > 0) {
    lines.push('', `files ${result.direction === 'upstream' ? 'importing' : 'imported by'} ${result.target.filePath}:`);
    for (const file of result.files) lines.push(`  - ${file.path}`);
  }
  const { summary } = result;
  lines.push(
    '',
    `risk: ${summary.risk} -- ${summary.reasons.join('; ')}`,
    ...(summary.testsSkipped > 0 ? [`${summary.testsSkipped} test declaration(s) left out (--include-tests to list them)`] : []),
    ...(summary.belowConfidence > 0 ? [`${summary.belowConfidence} edge(s) below the confidence floor ${result.minConfidence}`] : []),
    `processes: ${result.processes.note}`,
    ...formatProcessReport(result.processes),
  );
  return lines.join('\n');
}

/** The flows an answer touches, listed under the sentence that counts them. */
function formatProcessReport(report: ImpactResult['processes']): string[] {
  if (report.status !== 'ok' || report.items.length === 0) return [];
  return report.items.slice(0, 10).map((item) =>
    `  - ${item.name}  ${item.filePath}  (${item.steps} step(s)${item.depth === null ? '' : `, entered at d=${item.depth}`})`);
}

export function formatContext(result: ContextResult): string {
  const lines = [`${result.symbol.qualified}  (${result.symbol.kind})  ${result.symbol.filePath}:${result.symbol.startLine}-${result.symbol.endLine}`];
  if (result.container) lines.push(`in ${result.container.qualified}`);
  const section = (title: string, refs: Array<SymbolRef & { line?: number; confidence?: number }>) => {
    if (refs.length === 0) return;
    lines.push('', `${title} (${refs.length}):`);
    for (const ref of refs) {
      const confidence = ref.confidence !== undefined ? `  [${percent(ref.confidence)}]` : '';
      lines.push(`  ${ref.qualified}  ${where(ref, ref.line)}${confidence}`);
    }
  };
  section('members', result.members);
  section('called by', result.callers);
  section('calls', result.callees);
  section('derives from', result.bases);
  section('derived by', result.derived);
  if (result.file.imports.length > 0) lines.push('', `${result.file.path} imports: ${result.file.imports.join(', ')}`);
  if (result.file.importedBy.length > 0) lines.push(`${result.file.path} is imported by: ${result.file.importedBy.join(', ')}`);
  if (result.memories.length > 0) {
    lines.push('', 'recorded about it:');
    for (const memory of result.memories) lines.push(`  [${memory.layer}] ${memory.title}  (${memory.sourceRef})`);
  }
  lines.push('', `execution flows: ${result.processes.note}`, ...formatProcessReport(result.processes));
  return lines.join('\n');
}

export function formatTrace(result: TraceResult): string {
  if (result.status === 'no_path') {
    return [
      `no path from ${result.from.qualified} to ${result.to.qualified}`,
      result.furthest ? `the chain breaks after ${result.furthest.qualified}  ${where(result.furthest)}` : 'nothing is reachable from the start',
      ...(result.truncated ? ['the search hit its depth limit with ground left unexplored (--depth to go further)'] : []),
    ].join('\n');
  }
  const lines = [`${result.hops.length - 1} step(s) from ${result.from.qualified} to ${result.to.qualified}:`];
  result.hops.forEach((hop, i) => {
    const edge = result.edges[i - 1];
    const via = edge ? `  <- ${edge.relType}${edge.relType === 'CALLS' ? ` ${percent(edge.confidence)}` : ''}` : '';
    lines.push(`  ${i}. ${hop.qualified}  ${where(hop)}${via}`);
  });
  return lines.join('\n');
}

export function formatProcesses(result: ProcessListResult): string {
  const lines = [`${result.summary.processes} execution flow(s) from ${result.summary.entryPoints} entry point(s)`, ''];
  for (const process of result.processes) {
    lines.push(`  ${process.name}  ${process.filePath}:${process.startLine}  (${process.steps} step(s), depth ${process.depth}${process.truncated ? ', truncated' : ''})`);
  }
  lines.push(
    '',
    `rule: ${result.summary.rule}`,
    ...(result.summary.shown < result.summary.processes
      ? [`showing ${result.summary.shown} of ${result.summary.processes} (--limit for more)`]
      : []),
    ...(result.summary.truncated
      ? ['more entry points than the build limit: the flows with the most calls were kept']
      : []),
  );
  return lines.join('\n');
}

export function formatProcess(result: Process & { status: 'ok' }): string {
  const lines = [
    `${result.name}  ${result.entry.filePath}:${result.entry.startLine}`,
    `entry point because ${result.reason}`,
    '',
  ];
  let depth = 0;
  for (const step of result.steps) {
    if (step.depth !== depth) {
      depth = step.depth;
      lines.push(`d=${depth}:`);
    }
    lines.push(`  ${step.qualified}  ${where(step, step.line)}  [${step.via}, ${percent(step.confidence)}]`);
  }
  if (result.truncated) lines.push('', 'the walk stopped at its limit with calls left unfollowed');
  return lines.join('\n');
}

export function formatProcessUnresolved(result: ProcessUnresolved): string {
  if (result.status === 'not_found') {
    const lines = [`no execution flow named ${JSON.stringify(result.asked)}`];
    if (result.suggestions.length > 0) {
      lines.push('did you mean:');
      for (const item of result.suggestions) lines.push(`  ${item.name}  ${item.filePath}  (${item.steps} step(s))`);
    }
    return lines.join('\n');
  }
  return [
    `${JSON.stringify(result.asked)} names ${result.candidates.length} execution flows -- say which:`,
    ...result.candidates.map((item) => `  ${item.name}  ${item.filePath}  (${item.steps} step(s))   ${item.id}`),
  ].join('\n');
}

export function formatQuery(result: QueryResult): string {
  if (result.groups.length === 0) {
    return `nothing in the code graph matches ${JSON.stringify(result.query)}`;
  }
  const lines: string[] = [];
  for (const group of result.groups) {
    lines.push(group.process
      ? `flow: ${group.process.name}  ${group.process.filePath}  (${group.process.steps} step(s))`
      : 'in no execution flow that was built (nothing reaches them, or the flow that would stopped at its limit):');
    for (const hit of group.hits) {
      lines.push(`  ${hit.qualified}  ${where(hit)}  [${percent(hit.score)} on ${hit.matched.join('+')}]`);
    }
    for (const memory of group.memories) lines.push(`  recorded: [${memory.layer}] ${memory.title}`);
    lines.push('');
  }
  lines.push(`${result.summary.symbols} declaration(s) in ${result.summary.processes} flow(s); ${result.summary.unassigned} in none`);
  return lines.join('\n');
}

export type ChangeScope = 'staged' | 'working' | 'compare';

/**
 * A diff, read as declarations. Git is called here; the analysis itself is in
 * core and needs no repository.
 */
export async function runDetectChanges(
  options: { from?: string; scope?: ChangeScope; baseRef?: string; maxDepth?: number; includeTests?: boolean; flows?: boolean } = {},
): Promise<DetectChangesResult> {
  const scope = options.scope ?? 'staged';
  const project = resolveProject(options.from);
  const hunks = changedHunks(project.root, scope, options.baseRef);
  if (hunks === null) {
    throw new Error(
      `Could not read ${scope} changes from git in ${project.root}. An unborn branch or a bad base ref `
      + 'reports no changes, which would read as "nothing to check".',
    );
  }
  return withIndex(options.from, async (_store, index) => {
    const result = detectChanges(index, hunks, scope, {
      maxDepth: options.maxDepth,
      includeTests: options.includeTests,
      processes: flowsFor(index, options),
    });
    // The graph was built from a commit. If the working tree has moved on, the
    // line numbers this matched against are the old ones, and saying so is the
    // difference between an answer and a confident wrong answer.
    const staleness = isStale(storeDirOrThrow(options.from));
    if (staleness.stale) {
      result.limits.unshift(
        `The code graph was built at ${staleness.indexed ?? 'an unknown commit'} and HEAD is ${staleness.head ?? 'unknown'};`
        + ' declarations that moved since then may be matched at their old lines. Run `dai-memory ingest` to refresh.',
      );
    }
    return result;
  });
}

export async function runReview(
  options: { from?: string; baseRef?: string; maxDepth?: number; includeTests?: boolean; flows?: boolean } = {},
): Promise<ReviewResult> {
  const base = options.baseRef ?? 'HEAD';
  const changes = await runDetectChanges({ ...options, scope: 'compare', baseRef: base });
  const project = resolveProject(options.from);
  return review(changes, base, { history: fileAuthors(project.root, changes.files.map((file) => file.file)) });
}

export function formatDetectChanges(result: DetectChangesResult): string {
  const lines = [`${result.scope} changes: ${result.summary.symbols} declaration(s) in ${result.summary.files} file(s)`, ''];
  if (result.symbols.length === 0) {
    lines.push('no indexed declaration was touched');
  }
  for (const symbol of result.symbols) {
    const touched = symbol.touched.map((range) => range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`).join(', ');
    lines.push(`  ${symbol.change === 'removed' ? 'REMOVED ' : ''}${symbol.qualified}  ${symbol.filePath}:${touched}`);
    lines.push(`    ${symbol.dependents.total} dependent(s) within reach, ${symbol.dependents.external} outside this file -- risk ${symbol.dependents.risk}`);
    for (const ref of symbol.dependents.direct.slice(0, 5)) {
      lines.push(`      <- ${ref.qualified}  ${ref.filePath}:${ref.startLine}`);
    }
    for (const process of symbol.processes.slice(0, 3)) {
      lines.push(`      flow: ${process.name}  ${process.filePath}`);
    }
  }
  lines.push('', `risk: ${result.summary.risk} -- ${result.summary.reasons.join('; ')}`);
  for (const limit of result.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}

export function formatReview(result: ReviewResult): string {
  const lines = [`review against ${result.base}: risk ${result.summary.risk}`, ''];
  if (result.breaking.length === 0) {
    lines.push('nothing here can break code outside the file it was changed in');
  } else {
    lines.push(`can break other code (${result.breaking.length}):`);
    for (const item of result.breaking) {
      lines.push(`  ${item.symbol.qualified}  ${item.symbol.filePath}  -- ${item.reason}`);
      for (const ref of item.dependents.slice(0, 5)) lines.push(`      <- ${ref.qualified}  ${ref.filePath}:${ref.startLine}`);
    }
  }
  if (result.modules.length > 0) {
    lines.push('', 'modules touched:');
    for (const module of result.modules) {
      lines.push(`  ${module.module}  (${module.files} file(s), ${module.symbols} declaration(s))`);
    }
  }
  if (result.reviewers.length > 0) {
    lines.push('', 'who has worked here:');
    for (const reviewer of result.reviewers) {
      lines.push(`  ${reviewer.name}  (${reviewer.commits} commit(s) across ${reviewer.files} of these file(s))`);
    }
    lines.push(`  -- ${result.summary.reviewersFrom}`);
  }
  for (const limit of result.changes.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// rename

export type RenameResult =
  | (RenamePlan & { applied: null | { files: string[]; edits: number; skipped: number } })
  | RenameRefusal
  | Unresolved
  | { status: 'stale'; indexed: string | null; head: string | null; reason: string };

/**
 * A rename, planned from the graph and applied only when asked.
 *
 * Refused outright when the index is older than the working tree: the plan is
 * positions in files, and positions from a tree that has moved on are how a
 * rename corrupts source instead of changing it.
 */
export async function runRename(
  target: TargetQuery,
  to: string,
  options: { from?: string; apply?: boolean; includeTests?: boolean; includeText?: boolean } = {},
): Promise<RenameResult> {
  const project = resolveProject(options.from);
  const staleness = isStale(storeDirOrThrow(options.from));
  if (staleness.stale) {
    return {
      status: 'stale',
      indexed: staleness.indexed,
      head: staleness.head,
      reason: 'the code graph is older than the working tree, and a rename is positions in files. Run `dai-memory ingest` first.',
    };
  }

  const absolute = (file: string) => path.join(project.root, file);
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(absolute(file), 'utf8');
    } catch {
      return undefined;
    }
  };

  return withIndex(options.from, async (_store, index) => {
    const resolution = resolveTarget(index, target);
    const refused = unresolved('target', target, resolution);
    if (refused) return refused;

    const files = new Set<string>();
    for (const symbol of index.symbols.values()) files.add(symbol.filePath);
    const plan = planRename(index, (resolution as { id: string }).id, to, {
      read,
      includeTests: options.includeTests,
      scanText: files,
    });
    if (plan.status !== 'ok') return plan;
    if (!options.apply) return { ...plan, applied: null };

    const chosen = options.includeText
      ? [...plan.edits, ...plan.textOnly.map((match) => ({
        file: match.file, line: match.line, column: match.column, before: plan.from,
        via: 'call' as const, confidence: 0,
      }))]
      : plan.edits;
    const { files: written, skipped } = applyRename(plan, read, chosen);
    for (const file of written) fs.writeFileSync(absolute(file.file), file.text);
    return {
      ...plan,
      applied: {
        files: written.map((file) => file.file),
        edits: written.reduce((sum, file) => sum + file.edits, 0),
        skipped: skipped.length,
      },
    };
  });
}

export function formatRename(result: RenameResult): string {
  if (result.status === 'stale') {
    return [
      `refusing to rename: ${result.reason}`,
      `the graph was built at ${result.indexed ?? 'an unknown commit'}, HEAD is ${result.head ?? 'unknown'}`,
    ].join('\n');
  }
  if (result.status === 'invalid_name') return `cannot rename to ${JSON.stringify(result.to)}: ${result.reason}`;
  if (result.status === 'occupied') {
    return [
      `${JSON.stringify(result.to)} is already declared in this file:`,
      ...result.conflicts.map((ref) => `  ${ref.qualified}  ${ref.filePath}:${ref.startLine}`),
    ].join('\n');
  }
  if (result.status !== 'ok') return formatUnresolved(result as Unresolved);

  const lines = [
    `${result.applied ? 'renamed' : 'would rename'} ${result.from} -> ${result.to}: `
    + `${result.summary.edits} site(s) in ${result.summary.files} file(s)`,
    '',
  ];
  for (const edit of result.edits) {
    lines.push(`  ${edit.file}:${edit.line}:${edit.column}  [${edit.via}, ${percent(edit.confidence)}]`);
  }
  if (result.textOnly.length > 0) {
    lines.push('', `the word also appears here, and is not part of this rename (${result.textOnly.length}):`);
    for (const match of result.textOnly.slice(0, 20)) {
      lines.push(`  ${match.file}:${match.line}  ${match.context}   -- ${match.reason}`);
    }
    if (result.textOnly.length > 20) lines.push(`  ... and ${result.textOnly.length - 20} more`);
  }
  if (result.applied) {
    lines.push('', `wrote ${result.applied.edits} edit(s) to ${result.applied.files.length} file(s)`);
    if (result.applied.skipped > 0) lines.push(`${result.applied.skipped} site(s) skipped: the file did not hold what the plan expected`);
  } else {
    lines.push('', 'nothing was written. Pass --apply to make these edits.');
  }
  for (const limit of result.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// check, clusters, cypher, status

export async function runCheck(
  options: { from?: string; includeTests?: boolean; examples?: number } = {},
): Promise<CheckResult> {
  return withIndex(options.from, async (_store, index) =>
    check(index, { includeTests: options.includeTests, examples: options.examples }));
}

export async function runCodeClusters(
  options: { from?: string; minSize?: number; includeTests?: boolean; limit?: number } = {},
): Promise<{ status: 'ok'; clusters: CodeCluster[]; summary: { clusters: number; shown: number; rule: string } }> {
  return withIndex(options.from, async (_store, index) => {
    const found = codeClusters(index, { minSize: options.minSize, includeTests: options.includeTests });
    const limit = Math.max(1, Math.floor(options.limit ?? 20));
    return {
      status: 'ok' as const,
      clusters: found.slice(0, limit),
      summary: {
        clusters: found.length,
        shown: Math.min(limit, found.length),
        rule: 'Louvain communities over calls, inheritance and containment, named after the directory most of each lives in',
      },
    };
  });
}

export type CypherResult =
  | { status: 'ok'; query: string; rows: Record<string, unknown>[]; truncated: boolean }
  | { status: 'refused'; reason: string };

/** A read-only query against the store, guarded before it is sent. */
export async function runCypher(
  text: string,
  options: { from?: string; limit?: number } = {},
): Promise<CypherResult> {
  const limit = Math.max(1, Math.floor(options.limit ?? 100));
  const guarded = readOnlyCypher(text, limit);
  if (!guarded.ok) return { status: 'refused', reason: guarded.reason };
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const rows = await store.query(guarded.query);
    return { status: 'ok', query: guarded.query, rows, truncated: rows.length >= limit };
  } finally {
    await store.close();
  }
}

export interface StatusResult {
  status: 'ok';
  project: { name: string; root: string; branch: string | null; head: string | null };
  index: { indexedCommit: string | null; stale: boolean; schemaVersion: number; dimensions: number; embedding: string | null };
  graph: { files: number; declarations: number; calls: number; inherits: number; imports: number; ready: boolean };
}

export async function runStatus(options: { from?: string } = {}): Promise<StatusResult> {
  const project = resolveProject(options.from);
  const dir = storeDirOrThrow(options.from);
  const meta = readMeta(dir);
  const staleness = isStale(dir);
  const store = new MemoryStore(dir, { readOnly: true });
  try {
    const files = new Set<string>();
    let declarations = 0;
    if (store.graphReady) {
      for (const symbol of await store.allSymbols()) {
        files.add(symbol.filePath);
        declarations += 1;
      }
    }
    return {
      status: 'ok',
      project: { name: project.name, root: project.root, branch: project.branch, head: staleness.head },
      index: {
        indexedCommit: staleness.indexed,
        stale: staleness.stale,
        schemaVersion: meta.schemaVersion,
        dimensions: meta.dimensions,
        embedding: meta.embedding ? `${meta.embedding.provider}:${meta.embedding.model}` : null,
      },
      graph: {
        files: files.size,
        declarations,
        calls: store.graphReady ? (await store.allCalls()).length : 0,
        inherits: store.graphReady ? (await store.allInherits()).length : 0,
        imports: store.graphReady ? (await store.allImports()).length : 0,
        ready: store.graphReady,
      },
    };
  } finally {
    await store.close();
  }
}

export function formatCheck(result: CheckResult): string {
  const lines: string[] = [];
  if (result.findings.length === 0) lines.push('nothing to report');
  for (const finding of result.findings) {
    lines.push(`[${finding.severity}] ${finding.rule}: ${finding.message}`);
    for (const where of finding.where) lines.push(`    ${where}`);
  }
  lines.push('', 'what each rule looked at:');
  for (const [rule, count] of Object.entries(result.summary.examined)) {
    lines.push(`  ${rule}: ${count}`);
  }
  return lines.join('\n');
}

export function formatCodeClusters(result: { clusters: CodeCluster[]; summary: { clusters: number; shown: number; rule: string } }): string {
  const lines = [`${result.summary.clusters} cluster(s) in the code graph`, ''];
  for (const cluster of result.clusters) {
    lines.push(`${cluster.name}  (${cluster.size} declaration(s) in ${cluster.files.length} file(s))`);
    for (const member of cluster.members) lines.push(`    ${member.qualified}  ${member.filePath}:${member.startLine}  (${member.degree} edges)`);
  }
  lines.push('', `rule: ${result.summary.rule}`);
  if (result.summary.shown < result.summary.clusters) {
    lines.push(`showing ${result.summary.shown} of ${result.summary.clusters} (--limit for more)`);
  }
  return lines.join('\n');
}

export function formatCypher(result: CypherResult): string {
  if (result.status === 'refused') return `refused: ${result.reason}`;
  const lines = [result.query, ''];
  for (const row of result.rows) lines.push(JSON.stringify(row));
  lines.push('', `${result.rows.length} row(s)${result.truncated ? ' -- the limit was reached, there may be more' : ''}`);
  return lines.join('\n');
}

export function formatStatus(result: StatusResult): string {
  return [
    `${result.project.name}  ${result.project.root}`,
    `branch ${result.project.branch ?? 'unknown'}, HEAD ${result.project.head ?? 'unknown'}`,
    `indexed at ${result.index.indexedCommit ?? 'unknown'}${result.index.stale ? '  -- the working tree has moved on, run `dai-memory ingest`' : '  -- current'}`,
    `store: schema ${result.index.schemaVersion}, ${result.index.dimensions} dimensions, embedding ${result.index.embedding ?? 'none recorded'}`,
    result.graph.ready
      ? `graph: ${result.graph.declarations} declaration(s) in ${result.graph.files} file(s); ${result.graph.calls} call(s), ${result.graph.inherits} inherit(s), ${result.graph.imports} import(s)`
      : 'graph: not built -- run `dai-memory init`',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the HTTP surface

/** Reads a file from the project, for the extractors that work on text. */
function projectReader(from?: string): (file: string) => string | undefined {
  const project = resolveProject(from);
  return (file: string) => {
    try {
      return fs.readFileSync(path.join(project.root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
}

export async function runRouteMap(options: { from?: string; includeTests?: boolean } = {}): Promise<RouteMap> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) =>
    routeMap(index, { read, includeTests: options.includeTests }));
}

export async function runShapeCheck(options: { from?: string; includeTests?: boolean } = {}): Promise<ShapeCheckResult> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) =>
    shapeCheck(routeMap(index, { read, includeTests: options.includeTests }), { read }));
}

export async function runApiImpact(
  target: TargetQuery,
  options: { from?: string; maxDepth?: number; includeTests?: boolean } = {},
): Promise<ApiImpactResult | Unresolved> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) => {
    const resolution = resolveTarget(index, target);
    const refused = unresolved('target', target, resolution);
    if (refused) return refused;
    const map = routeMap(index, { read, includeTests: options.includeTests });
    return apiImpact(index, map, (resolution as { id: string }).id, {
      maxDepth: options.maxDepth,
      includeTests: options.includeTests,
    });
  });
}

export async function runToolMap(options: { from?: string; includeTests?: boolean } = {}): Promise<ToolMap> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) =>
    toolMap(index, { read, includeTests: options.includeTests }));
}

export function formatRouteMap(result: RouteMap): string {
  const lines = [`${result.summary.routes} route(s) across ${result.summary.filesScanned} file(s)`, ''];
  for (const route of result.routes) {
    lines.push(`  ${route.method.padEnd(6)} ${route.path ?? '(built at runtime)'}  ${route.file}:${route.line}`
      + `  [${route.framework}, ${percent(route.confidence)}]${route.handler ? `  -> ${route.handler.qualified}` : ''}`);
  }
  lines.push('', `frameworks found: ${result.summary.frameworks.join(', ') || 'none'}`);
  for (const limit of result.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}

export function formatShapeCheck(result: ShapeCheckResult): string {
  const lines = result.problems.length === 0
    ? ['nothing to report about the routes']
    : result.problems.map((problem) => [
      `[${problem.kind}] ${problem.message}`,
      ...problem.routes.map((route) => `    ${route.method} ${route.path ?? '(runtime)'}  ${route.file}:${route.line}`),
    ].join('\n'));
  lines.push('', `checked ${result.summary.routes} route(s) for: ${result.summary.checked.join('; ')}`);
  return lines.join('\n');
}

export function formatApiImpact(result: ApiImpactResult): string {
  const lines = [`endpoints answering through ${result.target.qualified}:`, ''];
  for (const route of result.routes) {
    lines.push(`  ${route.method.padEnd(6)} ${route.path ?? '(runtime)'}  ${route.file}:${route.line}  (d=${route.depth}, handler ${route.handler})`);
  }
  lines.push('', result.summary.note);
  return lines.join('\n');
}

export function formatToolMap(result: ToolMap): string {
  const lines = [`${result.summary.tools} MCP tool(s) declared in ${result.summary.filesScanned} file(s)`, ''];
  for (const tool of result.tools) {
    lines.push(`  ${tool.name}  ${tool.file}:${tool.line}  [${tool.style}]`);
    if (tool.description) lines.push(`      ${tool.description}`);
  }
  lines.push('', `looked for: ${result.summary.stylesLookedFor.join('; ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// taint, explain, pdg

export async function runTaint(
  options: { from?: string; includeTests?: boolean; maxDepth?: number } = {},
): Promise<TaintResult> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) =>
    taint(index, { read, includeTests: options.includeTests, maxDepth: options.maxDepth }));
}

export async function runExplain(
  target: TargetQuery & { path?: string },
  options: { from?: string; includeTests?: boolean; maxDepth?: number } = {},
): Promise<ExplainResult | Unresolved> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) => {
    const found = taint(index, { read, includeTests: options.includeTests, maxDepth: options.maxDepth });
    if (target.path) return explain(index, found, { file: target.path });
    const resolution = resolveTarget(index, target);
    const refused = unresolved('target', target, resolution);
    if (refused) return refused;
    return explain(index, found, { symbolId: (resolution as { id: string }).id });
  });
}

export async function runPdg(
  target: TargetQuery,
  options: { from?: string } = {},
): Promise<PdgResult | PdgFailure | Unresolved> {
  const read = projectReader(options.from);
  return withIndex(options.from, async (_store, index) => {
    const resolution = resolveTarget(index, target);
    const refused = unresolved('target', target, resolution);
    if (refused) return refused;
    const symbol = index.symbols.get((resolution as { id: string }).id)!;
    const content = read(symbol.filePath);
    if (content === undefined) {
      return {
        status: 'unsupported' as const,
        file: symbol.filePath,
        reason: 'the file could not be read from the working tree.',
      };
    }
    return pdg(symbol.filePath, content, { startLine: symbol.startLine, endLine: symbol.endLine });
  });
}

export function formatTaint(result: TaintResult): string {
  const lines = [`${result.summary.findings} place(s) where untrusted input could reach something dangerous`, ''];
  for (const finding of result.findings) {
    lines.push(`[${percent(finding.confidence)}${finding.sanitizers.length > 0 ? ', mitigated' : ''}] ${finding.source.hit.marker} -> ${finding.sink.hit.marker}`);
    lines.push(`    from  ${finding.source.symbol.qualified}  ${finding.source.symbol.filePath}:${finding.source.hit.line}`);
    lines.push(`          ${finding.source.hit.text}`);
    for (const hop of finding.path) lines.push(`    via   ${hop.qualified}  ${hop.filePath}:${hop.startLine}`);
    lines.push(`    to    ${finding.sink.symbol.qualified}  ${finding.sink.symbol.filePath}:${finding.sink.hit.line}`);
    lines.push(`          ${finding.sink.hit.text}`);
    for (const sanitizer of finding.sanitizers) {
      lines.push(`    but   ${sanitizer.hit.kind} at ${sanitizer.symbol.filePath}:${sanitizer.hit.line}`);
    }
    lines.push('');
  }
  lines.push(
    `scanned ${result.summary.declarationsScanned} declaration(s): ${result.summary.withSources} read untrusted input, ${result.summary.withSinks} reach something dangerous`,
  );
  for (const limit of result.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}

export function formatExplain(result: ExplainResult): string {
  const name = 'qualified' in result.target ? result.target.qualified : result.target.file;
  const lines = [`${name}: ${result.summary.note}`, ''];
  for (const finding of result.findings) {
    lines.push(`[${percent(finding.confidence)}] ${finding.source.symbol.qualified}:${finding.source.hit.line} (${finding.source.hit.kind})`
      + ` -> ${finding.sink.symbol.qualified}:${finding.sink.hit.line} (${finding.sink.hit.kind})`);
    lines.push(`    ${finding.why}`);
  }
  if (result.findings.length > 0) {
    lines.push('', `as the source of ${result.summary.asSource}, the sink of ${result.summary.asSink}, on the path of ${result.summary.onPath}`);
  }
  return lines.join('\n');
}

export function formatPdg(result: PdgResult | PdgFailure): string {
  if (result.status !== 'ok') return `cannot read the inside of this declaration: ${result.reason}`;
  const lines = [`${result.file}:${result.startLine}-${result.endLine}  (${result.language})`, '', 'names:'];
  for (const name of result.names) {
    lines.push(`  ${name.name}  defined at ${name.definedAt.join(', ') || '(not here)'}`
      + `  used at ${name.usedAt.join(', ') || '(not here)'}${name.underControl ? '  -- read under a condition' : ''}`);
  }
  if (result.control.length > 0) {
    lines.push('', 'runs only sometimes:');
    for (const region of result.control) {
      lines.push(`  ${region.kind}  lines ${region.line}-${region.endLine}${region.condition ? `  when ${region.condition}` : ''}`);
    }
  }
  for (const limit of result.limits) lines.push(`note: ${limit}`);
  return lines.join('\n');
}
