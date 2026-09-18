import {
  MemoryStore, loadCodeIndex, resolveTarget, impact, symbolContext, trace,
  buildProcesses, resolveProcess, query,
  type TargetQuery, type ImpactOptions, type ImpactResult, type ContextResult,
  type TraceResult, type TraceOptions, type Resolution, type CodeIndex, type SymbolRef,
  type ProcessIndex, type Process, type QueryResult,
} from '@memory-layer/core';
import { storeDirOrThrow } from './project.js';

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
