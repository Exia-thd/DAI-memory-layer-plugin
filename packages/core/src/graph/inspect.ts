import { createRequire } from 'node:module';
import type { CodeIndex, SymbolRef } from './code.js';
import { symbolRef, isTestPath } from './code.js';

const require = createRequire(import.meta.url);
const Graph = require('graphology') as new (options?: Record<string, unknown>) => {
  addNode(id: string): void;
  hasNode(id: string): boolean;
  mergeEdge(a: string, b: string, attributes?: Record<string, unknown>): void;
  order: number;
};
const louvain = require('graphology-communities-louvain') as (
  graph: unknown,
  options?: Record<string, unknown>,
) => Record<string, number>;

/**
 * Looking at the graph itself: what it says about the shape of the codebase,
 * and the questions nobody wrote a command for.
 *
 * Every answer here is derived from the same index the other commands use, and
 * every check states what it examined -- a clean report from a check that
 * looked at nothing is the failure this whole layer exists to avoid.
 */

// ---------------------------------------------------------------------------
// check

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Where to look, when there is somewhere. */
  where: string[];
}

export interface CheckResult {
  status: 'ok';
  findings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    /** What each rule looked at, so an empty result can be read. */
    examined: Record<string, number>;
  };
}

/**
 * Import cycles, as the files involved.
 *
 * Tarjan's algorithm over the file import graph: every strongly connected
 * component with more than one file is a cycle, and a file that imports itself
 * is one too. A cycle is not always wrong -- some languages handle them -- so
 * it is a warning that names the files, not a verdict.
 */
export function importCycles(index: CodeIndex): string[][] {
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const files = new Set<string>([...index.importsOut.keys(), ...index.importsIn.keys()]);

  const strongConnect = (file: string): void => {
    indexOf.set(file, counter);
    low.set(file, counter);
    counter += 1;
    stack.push(file);
    onStack.add(file);

    for (const next of index.importsOut.get(file) ?? []) {
      if (!files.has(next)) continue;
      if (!indexOf.has(next)) {
        strongConnect(next);
        low.set(file, Math.min(low.get(file)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(file, Math.min(low.get(file)!, indexOf.get(next)!));
      }
    }

    if (low.get(file) === indexOf.get(file)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== file);
      const selfImport = (index.importsOut.get(file) ?? []).includes(file);
      if (component.length > 1 || selfImport) cycles.push(component.sort());
    }
  };

  for (const file of files) if (!indexOf.has(file)) strongConnect(file);
  return cycles.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

export interface CheckOptions {
  includeTests?: boolean;
  /** How many examples each finding names. */
  examples?: number;
}

/**
 * The invariants worth stating about a code graph.
 *
 * Each rule reports what it examined as well as what it found, because "no
 * circular imports" and "no imports were resolved" produce the same empty list
 * and mean opposite things.
 */
export function check(index: CodeIndex, options: CheckOptions = {}): CheckResult {
  const includeTests = options.includeTests ?? false;
  const examples = Math.max(1, Math.floor(options.examples ?? 5));
  const findings: Finding[] = [];

  const cycles = importCycles(index);
  const importedFiles = new Set<string>([...index.importsOut.keys(), ...index.importsIn.keys()]);
  if (cycles.length > 0) {
    findings.push({
      rule: 'circular-imports',
      severity: 'warning',
      message: `${cycles.length} import cycle(s). Some languages allow them; each one is a file that cannot be understood, tested or loaded on its own.`,
      where: cycles.slice(0, examples).map((cycle) => cycle.join(' -> ')),
    });
  }

  // A declaration nothing calls that calls nothing: the graph knows of it and
  // sees it take part in nothing. Types are excluded -- a type is used by being
  // named, which is not a call.
  const isolated: SymbolRef[] = [];
  let callable = 0;
  for (const [id, symbol] of index.symbols) {
    if (/interface|type_alias|enum|struct|trait|class/i.test(symbol.kind)) continue;
    if (!includeTests && isTestPath(symbol.filePath)) continue;
    callable += 1;
    const used = (index.callsIn.get(id)?.length ?? 0) + (index.inheritsIn.get(id)?.length ?? 0)
      + (index.parent.has(id) ? 1 : 0);
    const uses = (index.callsOut.get(id)?.length ?? 0) + (index.children.get(id)?.length ?? 0);
    if (used === 0 && uses === 0) isolated.push(symbolRef(index, id));
  }
  if (isolated.length > 0) {
    findings.push({
      rule: 'isolated-declarations',
      severity: 'info',
      message: `${isolated.length} of ${callable} declaration(s) neither call anything nor are called. Some are exported for callers outside this repository, which this graph cannot see; the rest are dead.`,
      where: isolated.slice(0, examples).map((ref) => `${ref.qualified}  ${ref.filePath}:${ref.startLine}`),
    });
  }

  // Files that import others but declare nothing the graph could index: either
  // they hold only configuration, or the parser did not understand them.
  const declaring = new Set<string>();
  for (const symbol of index.symbols.values()) declaring.add(symbol.filePath);
  const silent = [...importedFiles].filter((file) => !declaring.has(file))
    .filter((file) => includeTests || !isTestPath(file));
  if (silent.length > 0) {
    findings.push({
      rule: 'files-without-declarations',
      severity: 'info',
      message: `${silent.length} file(s) take part in imports but declare nothing indexed. Configuration and re-export files look like this; so does a file whose language is not parsed.`,
      where: silent.slice(0, examples),
    });
  }

  const severityCount = (severity: Severity) => findings.filter((finding) => finding.severity === severity).length;
  return {
    status: 'ok',
    findings,
    summary: {
      errors: severityCount('error'),
      warnings: severityCount('warning'),
      info: severityCount('info'),
      examined: {
        'circular-imports': importedFiles.size,
        'isolated-declarations': callable,
        'files-without-declarations': importedFiles.size,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// code clusters

export interface CodeCluster {
  id: number;
  /** The directory most of it lives in, which is what people call it. */
  name: string;
  size: number;
  files: string[];
  /** The declarations most connected inside the cluster. */
  members: Array<SymbolRef & { degree: number }>;
}

/**
 * Communities in the call graph: the parts of a codebase that talk to each
 * other more than they talk to the rest.
 *
 * Louvain over calls and inheritance, undirected -- direction says who depends
 * on whom, and grouping is about how tightly a set of declarations is bound
 * together either way. Named after the directory most of the cluster lives in,
 * because that is the name its authors already use for it.
 */
export function codeClusters(
  index: CodeIndex,
  options: { minSize?: number; includeTests?: boolean; members?: number } = {},
): CodeCluster[] {
  const minSize = Math.max(2, Math.floor(options.minSize ?? 3));
  const includeTests = options.includeTests ?? false;
  const memberLimit = Math.max(1, Math.floor(options.members ?? 5));

  const graph = new Graph({ type: 'undirected', multi: false });
  const allowed = (id: string): boolean => {
    const symbol = index.symbols.get(id);
    return Boolean(symbol) && (includeTests || !isTestPath(symbol!.filePath));
  };

  for (const [id] of index.symbols) {
    if (allowed(id)) graph.addNode(id);
  }
  const link = (from: string, to: string): void => {
    if (!graph.hasNode(from) || !graph.hasNode(to) || from === to) return;
    graph.mergeEdge(from, to, { weight: 1 });
  };
  for (const [from, edges] of index.callsOut) for (const edge of edges) link(from, edge.to);
  for (const [from, edges] of index.inheritsOut) for (const edge of edges) link(from, edge.to);
  for (const [parent, children] of index.children) for (const child of children) link(parent, child);

  if (graph.order === 0) return [];
  const assignment = louvain(graph, { getEdgeWeight: 'weight' });

  const byCommunity = new Map<number, string[]>();
  for (const [id, community] of Object.entries(assignment)) {
    const list = byCommunity.get(community);
    if (list) list.push(id);
    else byCommunity.set(community, [id]);
  }

  const degree = (id: string): number =>
    (index.callsIn.get(id)?.length ?? 0) + (index.callsOut.get(id)?.length ?? 0)
    + (index.inheritsIn.get(id)?.length ?? 0) + (index.inheritsOut.get(id)?.length ?? 0);

  const clusters: CodeCluster[] = [];
  for (const [community, ids] of byCommunity) {
    if (ids.length < minSize) continue;
    const files = [...new Set(ids.map((id) => index.symbols.get(id)!.filePath))].sort();
    const directories = new Map<string, number>();
    for (const file of files) {
      const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '(root)';
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
    const name = [...directories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    clusters.push({
      id: community,
      name,
      size: ids.length,
      files,
      members: ids.map((id) => ({ ...symbolRef(index, id), degree: degree(id) }))
        .sort((a, b) => b.degree - a.degree || a.qualified.localeCompare(b.qualified))
        .slice(0, memberLimit),
    });
  }
  return clusters.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// cypher

export type CypherCheck = { ok: true; query: string } | { ok: false; reason: string };

/** Clauses that write, or reach outside the query. */
const FORBIDDEN = /\b(create|merge|set|delete|detach|remove|drop|load\s+csv|copy|import|install|attach|call)\b/i;

/**
 * A query the store may answer, or a refusal saying why not.
 *
 * Read-only is enforced by refusing every writing clause rather than by
 * trusting a flag, and one statement at a time: a guard that inspects the
 * first statement and runs the rest is not a guard. A query with no LIMIT gets
 * one, so a mistyped pattern cannot return the whole store.
 */
export function readOnlyCypher(text: string, limit = 100): CypherCheck {
  const query = text.trim().replace(/;\s*$/, '');
  if (!query) return { ok: false, reason: 'no query' };
  if (query.includes(';')) {
    return { ok: false, reason: 'one statement at a time: a query containing ; is refused rather than partly run' };
  }
  const forbidden = FORBIDDEN.exec(query);
  if (forbidden) {
    return { ok: false, reason: `this is read-only, and ${forbidden[0].toUpperCase()} writes or reaches outside the query` };
  }
  if (!/\breturn\b/i.test(query)) {
    return { ok: false, reason: 'a read-only query has to RETURN something' };
  }
  const bounded = /\blimit\s+\d+\s*$/i.test(query) ? query : `${query} LIMIT ${Math.max(1, Math.floor(limit))}`;
  return { ok: true, query: bounded };
}
