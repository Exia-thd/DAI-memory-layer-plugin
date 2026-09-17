import type { MemoryStore } from '../store/store.js';
import type { MemoryNode, SymbolRow } from '../types.js';

/**
 * Questions about code, answered from the code graph: what reaches a
 * declaration, what it reaches, what surrounds it, and how one gets to another.
 *
 * Everything here reads one in-memory index built from the store in a handful
 * of queries. A blast radius three hops deep is thousands of neighbour lookups,
 * and a round trip per lookup would make the question slower to ask than to
 * answer by reading the code.
 */

/**
 * How far an edge can be trusted, as a number.
 *
 * Resolution records how it placed each call, and the placements are not
 * equally sure: a receiver whose declared type names the owner is as good as
 * static analysis without a type checker gets; a name that happens to be
 * declared once in the repository is a good guess and no more. The numbers are
 * an ordering with room for a threshold, not a probability anyone measured.
 */
export const CONFIDENCE_SCORE: Record<string, number> = {
  type: 1,
  file: 0.95,
  receiver: 0.9,
  import: 0.85,
  unique: 0.7,
};

export function confidenceScore(label: string): number {
  return CONFIDENCE_SCORE[label] ?? 0.5;
}

interface Edge {
  to: string;
  line: number;
  confidence: number;
  label: string;
}

export interface CodeIndex {
  symbols: Map<string, SymbolRow>;
  callsOut: Map<string, Edge[]>;
  callsIn: Map<string, Edge[]>;
  inheritsOut: Map<string, Edge[]>;
  inheritsIn: Map<string, Edge[]>;
  importsOut: Map<string, string[]>;
  importsIn: Map<string, string[]>;
  parent: Map<string, string>;
  children: Map<string, string[]>;
  byName: Map<string, string[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** `Symbol:<file>:<Outer.Inner>` → `Outer.Inner`. */
export function qualifiedName(symbol: SymbolRow): string {
  const prefix = `Symbol:${symbol.filePath}:`;
  return symbol.id.startsWith(prefix) ? symbol.id.slice(prefix.length) : symbol.name;
}

/**
 * A path that holds tests rather than the code under test.
 *
 * Kept out of blast radii by default: a changed function breaking its own test
 * is the test doing its job, and listing it next to production callers buries
 * the ones that matter.
 */
export function isTestPath(file: string): boolean {
  const path = file.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(tests?|__tests__|spec|specs)\//.test(path)
    || /\.(test|spec)\.[a-z0-9]+$/.test(path)
    || /(^|\/)test_[^/]+\.py$/.test(path)
    || /_test\.(go|py|rb|exs?)$/.test(path)
    || /tests?\.cs$/.test(path);
}

export async function loadCodeIndex(store: MemoryStore): Promise<CodeIndex> {
  const index: CodeIndex = {
    symbols: new Map(),
    callsOut: new Map(),
    callsIn: new Map(),
    inheritsOut: new Map(),
    inheritsIn: new Map(),
    importsOut: new Map(),
    importsIn: new Map(),
    parent: new Map(),
    children: new Map(),
    byName: new Map(),
  };

  for (const symbol of await store.allSymbols()) {
    index.symbols.set(symbol.id, symbol);
    push(index.byName, symbol.name.toLowerCase(), symbol.id);
  }

  // Containment is spelled in the id: the enclosing declaration is the prefix
  // before the last dot, when a declaration with that id exists.
  for (const symbol of index.symbols.values()) {
    const qualified = qualifiedName(symbol);
    const dot = qualified.lastIndexOf('.');
    if (dot === -1) continue;
    const parent = `Symbol:${symbol.filePath}:${qualified.slice(0, dot)}`;
    if (!index.symbols.has(parent)) continue;
    index.parent.set(symbol.id, parent);
    push(index.children, parent, symbol.id);
  }

  for (const call of await store.allCalls()) {
    const score = confidenceScore(call.confidence);
    push(index.callsOut, call.from, { to: call.to, line: Number(call.line ?? 0), confidence: score, label: call.confidence });
    push(index.callsIn, call.to, { to: call.from, line: Number(call.line ?? 0), confidence: score, label: call.confidence });
  }
  for (const edge of await store.allInherits()) {
    const score = confidenceScore(edge.confidence);
    push(index.inheritsOut, edge.from, { to: edge.to, line: 0, confidence: score, label: edge.confidence });
    push(index.inheritsIn, edge.to, { to: edge.from, line: 0, confidence: score, label: edge.confidence });
  }
  for (const edge of await store.allImports()) {
    push(index.importsOut, edge.from, edge.to);
    push(index.importsIn, edge.to, edge.from);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Naming a declaration

export interface SymbolRef {
  id: string;
  name: string;
  qualified: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export function symbolRef(index: CodeIndex, id: string): SymbolRef {
  const symbol = index.symbols.get(id)!;
  return {
    id,
    name: symbol.name,
    qualified: qualifiedName(symbol),
    kind: symbol.kind,
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}

export interface TargetQuery {
  /** A name, a qualified name (`Class.method`), or `file:qualified`. */
  name?: string;
  /** The exact id, with or without its `Symbol:` tag. Removes all ambiguity. */
  uid?: string;
  /** Narrows a name to declarations in files ending with this path. */
  file?: string;
}

export type Resolution =
  | { status: 'ok'; id: string }
  | { status: 'ambiguous'; candidates: Array<SymbolRef & { degree: number }> }
  | { status: 'not_found'; suggestions: SymbolRef[] };

function degree(index: CodeIndex, id: string): number {
  return (index.callsIn.get(id)?.length ?? 0) + (index.callsOut.get(id)?.length ?? 0)
    + (index.inheritsIn.get(id)?.length ?? 0) + (index.inheritsOut.get(id)?.length ?? 0);
}

/**
 * The declaration a question is about -- or, when a name fits several, all of
 * them ranked, so the caller can say which one.
 *
 * Guessing is the thing not done. `validate` declared in four classes has four
 * different blast radii, and answering with whichever came first would be an
 * answer to a question nobody asked.
 */
export function resolveTarget(index: CodeIndex, query: TargetQuery): Resolution {
  if (query.uid) {
    const id = query.uid.startsWith('Symbol:') ? query.uid : `Symbol:${query.uid}`;
    return index.symbols.has(id) ? { status: 'ok', id } : { status: 'not_found', suggestions: [] };
  }
  const raw = (query.name ?? '').trim();
  if (!raw) return { status: 'not_found', suggestions: [] };

  let pool: string[];
  const qualifiedAt = raw.lastIndexOf(':');
  if (qualifiedAt > 0 && index.symbols.has(`Symbol:${raw}`)) {
    pool = [`Symbol:${raw}`];
  } else if (raw.includes('.')) {
    const leaf = raw.slice(raw.lastIndexOf('.') + 1).toLowerCase();
    pool = (index.byName.get(leaf) ?? []).filter((id) => {
      const qualified = qualifiedName(index.symbols.get(id)!);
      return qualified === raw || qualified.endsWith(`.${raw}`);
    });
  } else {
    const all = index.byName.get(raw.toLowerCase()) ?? [];
    const exact = all.filter((id) => index.symbols.get(id)!.name === raw);
    pool = exact.length > 0 ? exact : all;
  }

  if (query.file) {
    const wanted = query.file.replace(/\\/g, '/');
    pool = pool.filter((id) => index.symbols.get(id)!.filePath.endsWith(wanted));
  }

  if (pool.length === 1) return { status: 'ok', id: pool[0]! };
  if (pool.length > 1) {
    const candidates = pool
      .map((id) => ({ ...symbolRef(index, id), degree: degree(index, id) }))
      .sort((a, b) =>
        Number(isTestPath(a.filePath)) - Number(isTestPath(b.filePath))
        || b.degree - a.degree
        || a.filePath.localeCompare(b.filePath));
    return { status: 'ambiguous', candidates };
  }

  const needle = raw.toLowerCase();
  const suggestions: SymbolRef[] = [];
  for (const [name, ids] of index.byName) {
    if (suggestions.length >= 5) break;
    if (name.includes(needle) || needle.includes(name)) suggestions.push(symbolRef(index, ids[0]!));
  }
  return { status: 'not_found', suggestions };
}

// ---------------------------------------------------------------------------
// impact

export type Direction = 'upstream' | 'downstream';

export const DEPTH_LABELS: Record<number, string> = {
  1: 'WILL BREAK',
  2: 'LIKELY AFFECTED',
  3: 'MAY NEED TESTING',
};

export interface ImpactHit extends SymbolRef {
  depth: number;
  /** How the step into this declaration was made. */
  via: 'CALLS' | 'INHERITS' | 'MEMBER';
  /** The edge's own confidence, and the product along the whole path. */
  confidence: number;
  pathConfidence: number;
  /** The declaration this one was reached from. */
  from: string;
  line: number;
}

export interface ImpactOptions {
  direction?: Direction;
  maxDepth?: number;
  minConfidence?: number;
  includeTests?: boolean;
}

export const MAX_IMPACT_DEPTH = 5;

/**
 * Names that put a change on a critical path. A handful of callers of the
 * function that checks a password is not a low-risk change, whatever the count.
 */
const CRITICAL = /auth|login|logout|session|token|password|passwd|credential|permission|role|acl|payment|billing|checkout|invoice|charge|refund|subscription|entitlement|crypto|encrypt|decrypt|secret|signature|security/i;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ImpactResult {
  status: 'ok';
  target: SymbolRef;
  direction: Direction;
  maxDepth: number;
  minConfidence: number;
  byDepth: Record<number, ImpactHit[]>;
  labels: Record<number, string>;
  /** Files that import the target's file (upstream) or that it imports (downstream). */
  files: Array<{ path: string; depth: number }>;
  summary: {
    symbols: number;
    files: number;
    testsSkipped: number;
    belowConfidence: number;
    risk: RiskLevel;
    /** Which rule set the risk, in words. */
    reasons: string[];
  };
  /** Execution flows are not computed yet; said, rather than returned empty. */
  processes: { status: 'not_computed'; note: string };
}

/**
 * Everything a change to one declaration can reach, by distance.
 *
 * Upstream is what depends on the target: its callers, the types that derive
 * from it, and -- for a type -- whatever calls its members, since using a
 * member is using the type. Downstream is the reverse. Each declaration is
 * reported once, at the shortest distance it was found, with the confidence of
 * the edge that reached it and of the whole path.
 */
export function impact(index: CodeIndex, targetId: string, options: ImpactOptions = {}): ImpactResult {
  const direction = options.direction ?? 'upstream';
  const maxDepth = Math.max(1, Math.min(MAX_IMPACT_DEPTH, Math.floor(options.maxDepth ?? 3)));
  const minConfidence = Math.max(0, Math.min(1, options.minConfidence ?? 0));
  const includeTests = options.includeTests ?? false;

  const calls = direction === 'upstream' ? index.callsIn : index.callsOut;
  const inherits = direction === 'upstream' ? index.inheritsIn : index.inheritsOut;

  const seen = new Set<string>([targetId]);
  const byDepth: Record<number, ImpactHit[]> = {};
  let testsSkipped = 0;
  let belowConfidence = 0;
  let frontier: Array<{ id: string; pathConfidence: number }> = [{ id: targetId, pathConfidence: 1 }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Array<{ id: string; pathConfidence: number }> = [];
    for (const { id, pathConfidence } of frontier) {
      // A type is used through its members: their callers are its dependents.
      const sources = [id, ...(index.children.get(id) ?? [])];
      const steps: Array<{ edge: Edge; via: ImpactHit['via']; from: string }> = [];
      for (const source of sources) {
        const via: ImpactHit['via'] = source === id ? 'CALLS' : 'MEMBER';
        for (const edge of calls.get(source) ?? []) steps.push({ edge, via, from: source });
        for (const edge of inherits.get(source) ?? []) steps.push({ edge, via: 'INHERITS', from: source });
      }

      for (const { edge, via, from } of steps) {
        if (seen.has(edge.to)) continue;
        if (edge.confidence < minConfidence) {
          belowConfidence += 1;
          continue;
        }
        const symbol = index.symbols.get(edge.to);
        if (!symbol) continue;
        if (!includeTests && isTestPath(symbol.filePath)) {
          seen.add(edge.to);
          testsSkipped += 1;
          continue;
        }
        seen.add(edge.to);
        const hit: ImpactHit = {
          ...symbolRef(index, edge.to),
          depth,
          via,
          confidence: edge.confidence,
          pathConfidence: Number((pathConfidence * edge.confidence).toFixed(4)),
          from,
          line: edge.line,
        };
        (byDepth[depth] ??= []).push(hit);
        next.push({ id: edge.to, pathConfidence: hit.pathConfidence });
      }
    }
    frontier = next;
  }

  for (const hits of Object.values(byDepth)) {
    hits.sort((a, b) => b.pathConfidence - a.pathConfidence || a.filePath.localeCompare(b.filePath));
  }

  // Files that import the target's file (or that it imports): the direct
  // dependents at file granularity, which a symbol-level walk cannot see when
  // the use is a re-export or a type-only import.
  const target = index.symbols.get(targetId)!;
  const fileDepth = new Map<string, number>();
  const fileEdges = direction === 'upstream' ? index.importsIn : index.importsOut;
  for (const other of fileEdges.get(target.filePath) ?? []) {
    if (!includeTests && isTestPath(other)) continue;
    if (!fileDepth.has(other)) fileDepth.set(other, 1);
  }
  const files = [...fileDepth].map(([path, depth]) => ({ path, depth }))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  const symbols = Object.values(byDepth).reduce((sum, hits) => sum + hits.length, 0);
  const reasons: string[] = [];
  let risk: RiskLevel = symbols < 5 ? 'LOW' : symbols <= 15 ? 'MEDIUM' : 'HIGH';
  reasons.push(`${symbols} dependent declaration(s) within ${maxDepth} hop(s)`);
  const critical = [symbolRef(index, targetId), ...(byDepth[1] ?? [])]
    .filter((ref) => CRITICAL.test(`${ref.qualified} ${ref.filePath}`));
  if (critical.length > 0) {
    risk = 'CRITICAL';
    reasons.push(`on a critical path: ${critical.slice(0, 3).map((ref) => ref.qualified).join(', ')}`);
  }

  return {
    status: 'ok',
    target: symbolRef(index, targetId),
    direction,
    maxDepth,
    minConfidence,
    byDepth,
    labels: Object.fromEntries(
      Object.keys(byDepth).map((depth) => [depth, DEPTH_LABELS[Number(depth)] ?? 'TRANSITIVE']),
    ),
    files,
    summary: { symbols, files: files.length, testsSkipped, belowConfidence, risk, reasons },
    processes: {
      status: 'not_computed',
      note: 'Execution flows are not built yet, so no process is listed. That is not the same as none being affected.',
    },
  };
}

// ---------------------------------------------------------------------------
// context

export interface Reference extends SymbolRef {
  line: number;
  confidence: number;
}

export interface ContextResult {
  status: 'ok';
  symbol: SymbolRef;
  container: SymbolRef | null;
  members: SymbolRef[];
  callers: Reference[];
  callees: Reference[];
  bases: Reference[];
  derived: Reference[];
  file: { path: string; imports: string[]; importedBy: string[] };
  memories: Array<Pick<MemoryNode, 'id' | 'title' | 'layer' | 'sourceRef' | 'importance'>>;
  processes: { status: 'not_computed'; note: string };
}

function references(index: CodeIndex, edges: Edge[] | undefined): Reference[] {
  const out = new Map<string, Reference>();
  for (const edge of edges ?? []) {
    if (!index.symbols.has(edge.to) || out.has(edge.to)) continue;
    out.set(edge.to, { ...symbolRef(index, edge.to), line: edge.line, confidence: edge.confidence });
  }
  return [...out.values()].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
}

/** One declaration from every side: what surrounds it, uses it, and what it uses. */
export async function context(store: MemoryStore, index: CodeIndex, targetId: string): Promise<ContextResult> {
  const symbol = index.symbols.get(targetId)!;
  const parent = index.parent.get(targetId);
  const memories = await store.nodesAboutSymbolIds([targetId, ...(index.children.get(targetId) ?? [])], 20);
  return {
    status: 'ok',
    symbol: symbolRef(index, targetId),
    container: parent ? symbolRef(index, parent) : null,
    members: (index.children.get(targetId) ?? []).map((id) => symbolRef(index, id))
      .sort((a, b) => a.startLine - b.startLine),
    callers: references(index, index.callsIn.get(targetId)),
    callees: references(index, index.callsOut.get(targetId)),
    bases: references(index, index.inheritsOut.get(targetId)),
    derived: references(index, index.inheritsIn.get(targetId)),
    file: {
      path: symbol.filePath,
      imports: [...new Set(index.importsOut.get(symbol.filePath) ?? [])].sort(),
      importedBy: [...new Set(index.importsIn.get(symbol.filePath) ?? [])].sort(),
    },
    memories: memories.map((node) => ({
      id: node.id, title: node.title, layer: node.layer, sourceRef: node.sourceRef, importance: node.importance,
    })),
    processes: {
      status: 'not_computed',
      note: 'Execution flows are not built yet, so no process is listed.',
    },
  };
}

// ---------------------------------------------------------------------------
// trace

export interface TraceOptions {
  maxDepth?: number;
  includeTests?: boolean;
}

export const MAX_TRACE_DEPTH = 30;

export interface TraceResult {
  status: 'ok' | 'no_path';
  from: SymbolRef;
  to: SymbolRef;
  hops: SymbolRef[];
  /** Aligned with the gaps between hops: edges[i] joins hops[i] to hops[i + 1]. */
  edges: Array<{ relType: 'CALLS' | 'HAS_MEMBER'; confidence: number; line: number }>;
  /** When there is no path: the farthest declaration reached, where the chain breaks. */
  furthest: SymbolRef | null;
  /** True when the search stopped at maxDepth with ground still unexplored. */
  truncated: boolean;
}

/**
 * The shortest way from one declaration to another.
 *
 * Calls are followed forwards, and a type is entered through its members, so a
 * trace can start at a class and still find the method that does the work.
 * Breadth-first, so the first path found is a shortest one.
 */
export function trace(index: CodeIndex, fromId: string, toId: string, options: TraceOptions = {}): TraceResult {
  const maxDepth = Math.max(1, Math.min(MAX_TRACE_DEPTH, Math.floor(options.maxDepth ?? 10)));
  const includeTests = options.includeTests ?? false;

  const previous = new Map<string, { from: string; relType: 'CALLS' | 'HAS_MEMBER'; confidence: number; line: number }>();
  const distance = new Map<string, number>([[fromId, 0]]);
  let frontier = [fromId];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !distance.has(toId); depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const steps: Array<{ to: string; relType: 'CALLS' | 'HAS_MEMBER'; confidence: number; line: number }> = [
        ...(index.callsOut.get(id) ?? []).map((edge) => ({ to: edge.to, relType: 'CALLS' as const, confidence: edge.confidence, line: edge.line })),
        ...(index.children.get(id) ?? []).map((child) => ({ to: child, relType: 'HAS_MEMBER' as const, confidence: 1, line: 0 })),
      ];
      for (const step of steps) {
        if (distance.has(step.to)) continue;
        const symbol = index.symbols.get(step.to);
        if (!symbol) continue;
        // Tests may end a trace but not carry one: a path through a test file
        // is not a path the running code takes.
        if (!includeTests && step.to !== toId && isTestPath(symbol.filePath)) continue;
        distance.set(step.to, depth);
        previous.set(step.to, { from: id, ...step });
        next.push(step.to);
      }
    }
    frontier = next;
    if (depth === maxDepth && frontier.length > 0 && !distance.has(toId)) truncated = true;
  }

  const from = symbolRef(index, fromId);
  const to = symbolRef(index, toId);
  if (!distance.has(toId)) {
    let furthestId: string | null = null;
    let far = 0;
    for (const [id, d] of distance) {
      if (d > far) { far = d; furthestId = id; }
    }
    return {
      status: 'no_path', from, to, hops: [], edges: [],
      furthest: furthestId ? symbolRef(index, furthestId) : null,
      truncated,
    };
  }

  const hops: SymbolRef[] = [];
  const edges: TraceResult['edges'] = [];
  for (let at: string | undefined = toId; at; at = previous.get(at)?.from) {
    hops.unshift(symbolRef(index, at));
    const step = previous.get(at);
    if (step) edges.unshift({ relType: step.relType, confidence: step.confidence, line: step.line });
  }
  return { status: 'ok', from, to, hops, edges, furthest: null, truncated: false };
}
