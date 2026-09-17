import {
  MemoryStore, loadCodeIndex, resolveTarget, impact, symbolContext, trace,
  type TargetQuery, type ImpactOptions, type ImpactResult, type ContextResult,
  type TraceResult, type TraceOptions, type Resolution, type CodeIndex, type SymbolRef,
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

export async function runImpact(
  target: TargetQuery,
  options: ImpactOptions & { from?: string } = {},
): Promise<ImpactResult | Unresolved> {
  return withIndex(options.from, async (_store, index) => {
    const resolution = resolveTarget(index, target);
    return unresolved('target', target, resolution) ?? impact(index, (resolution as { id: string }).id, options);
  });
}

export async function runContext(target: TargetQuery, options: { from?: string } = {}): Promise<ContextResult | Unresolved> {
  return withIndex(options.from, async (store, index) => {
    const resolution = resolveTarget(index, target);
    return unresolved('target', target, resolution)
      ?? symbolContext(store, index, (resolution as { id: string }).id);
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
  );
  return lines.join('\n');
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
