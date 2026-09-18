import type { CodeIndex, SymbolRef } from './code.js';
import { isTestPath, symbolRef } from './code.js';

/**
 * Execution flows: what runs, in order, once something enters the code.
 *
 * A call graph says which declarations touch each other. It does not say where
 * running starts, and "who calls this" is a different question from "what is
 * this part of". A flow answers the second: one entry point, and everything
 * reachable forwards from it, in the order the calls are made.
 *
 * Flows are derived, not declared. Nothing in the repository says "this is an
 * entry point", so the rule is stated here and reported with every answer: a
 * declaration nothing calls, that calls something itself. That finds route
 * handlers, CLI commands, `main`, exported library functions and event
 * handlers, and it also finds dead code -- a function nobody calls looks
 * exactly like one only the framework calls, and this layer cannot tell them
 * apart. Rather than guess, every flow carries the reason it was started.
 */

export const MAX_PROCESS_DEPTH = 6;
export const MAX_PROCESS_STEPS = 60;
/**
 * A cap on how many flows are built, so a large repository answers in about the
 * time a question is worth waiting for. Entry points are ranked before the cap
 * applies, and a truncated build says so rather than presenting the first N as
 * all of them.
 */
export const MAX_PROCESSES = 400;

/** Declaration kinds that are a type rather than something that runs. */
const TYPE_KIND = /interface|type_alias|enum|struct|trait|class/i;

export interface ProcessStep extends SymbolRef {
  depth: number;
  via: 'CALLS' | 'MEMBER';
  confidence: number;
  pathConfidence: number;
  /** The declaration this step was reached from. */
  from: string;
  line: number;
}

export interface Process {
  /** `Process:<file>:<qualified entry name>`. Derived, so it is stable. */
  id: string;
  name: string;
  entry: SymbolRef;
  /** Why this declaration was taken for an entry point, in words. */
  reason: string;
  steps: ProcessStep[];
  /** Entry and steps, for membership tests. */
  symbolIds: string[];
  depth: number;
  /** True when the walk stopped at a limit with calls left unfollowed. */
  truncated: boolean;
}

export interface ProcessIndex {
  processes: Process[];
  byId: Map<string, Process>;
  /** Every declaration, to the flows it takes part in. */
  bySymbol: Map<string, string[]>;
  byName: Map<string, string[]>;
  /** How many entry points were found, and how many became flows. */
  entryPoints: number;
  truncated: boolean;
}

export interface ProcessOptions {
  maxDepth?: number;
  maxSteps?: number;
  maxProcesses?: number;
  includeTests?: boolean;
}

/**
 * Where running can start: a declaration nothing in the graph calls, which
 * calls something itself.
 *
 * Types are left out -- a class is entered through its methods, and those are
 * considered on their own.
 */
export function entryPoints(index: CodeIndex, options: { includeTests?: boolean } = {}): string[] {
  const includeTests = options.includeTests ?? false;
  const found: string[] = [];
  for (const [id, symbol] of index.symbols) {
    if (TYPE_KIND.test(symbol.kind)) continue;
    if (!includeTests && isTestPath(symbol.filePath)) continue;
    if ((index.callsIn.get(id)?.length ?? 0) > 0) continue;
    if ((index.callsOut.get(id)?.length ?? 0) === 0) continue;
    found.push(id);
  }
  // Most calls first: when the cap bites, the flows that describe the most
  // behaviour are the ones that survive it.
  return found.sort((a, b) =>
    (index.callsOut.get(b)?.length ?? 0) - (index.callsOut.get(a)?.length ?? 0)
    || a.localeCompare(b));
}

function walk(
  index: CodeIndex,
  entryId: string,
  maxDepth: number,
  maxSteps: number,
  includeTests: boolean,
): { steps: ProcessStep[]; truncated: boolean } {
  const steps: ProcessStep[] = [];
  const seen = new Set<string>([entryId]);
  let frontier: Array<{ id: string; pathConfidence: number }> = [{ id: entryId, pathConfidence: 1 }];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Array<{ id: string; pathConfidence: number }> = [];
    for (const { id, pathConfidence } of frontier) {
      const outgoing = [
        ...(index.callsOut.get(id) ?? []).map((edge) => ({ edge, via: 'CALLS' as const })),
        ...(index.children.get(id) ?? []).map((child) => ({
          edge: { to: child, line: 0, confidence: 1, label: 'member' },
          via: 'MEMBER' as const,
        })),
      ];
      for (const { edge, via } of outgoing) {
        if (seen.has(edge.to)) continue;
        const symbol = index.symbols.get(edge.to);
        if (!symbol) continue;
        if (!includeTests && isTestPath(symbol.filePath)) continue;
        if (steps.length >= maxSteps) return { steps, truncated: true };
        seen.add(edge.to);
        const step: ProcessStep = {
          ...symbolRef(index, edge.to),
          depth,
          via,
          confidence: edge.confidence,
          pathConfidence: Number((pathConfidence * edge.confidence).toFixed(4)),
          from: id,
          line: edge.line,
        };
        steps.push(step);
        next.push({ id: edge.to, pathConfidence: step.pathConfidence });
      }
    }
    if (depth === maxDepth && next.length > 0) truncated = true;
    frontier = next;
  }
  return { steps, truncated };
}

/**
 * Every execution flow in the graph, from its entry point forwards.
 *
 * Breadth-first, so a step's depth is the fewest calls from the entry that
 * reach it, and each declaration appears once per flow however many ways in it
 * has. A declaration can take part in many flows, and the index says which.
 */
export function buildProcesses(index: CodeIndex, options: ProcessOptions = {}): ProcessIndex {
  const maxDepth = Math.max(1, Math.min(MAX_PROCESS_DEPTH, Math.floor(options.maxDepth ?? MAX_PROCESS_DEPTH)));
  const maxSteps = Math.max(1, Math.min(MAX_PROCESS_STEPS, Math.floor(options.maxSteps ?? MAX_PROCESS_STEPS)));
  const maxProcesses = Math.max(1, Math.floor(options.maxProcesses ?? MAX_PROCESSES));
  const includeTests = options.includeTests ?? false;

  const entries = entryPoints(index, { includeTests });
  const processes: Process[] = [];
  const byId = new Map<string, Process>();
  const bySymbol = new Map<string, string[]>();
  const byName = new Map<string, string[]>();

  for (const entryId of entries.slice(0, maxProcesses)) {
    const { steps, truncated } = walk(index, entryId, maxDepth, maxSteps, includeTests);
    if (steps.length === 0) continue;
    const entry = symbolRef(index, entryId);
    const process: Process = {
      id: `Process:${entry.filePath}:${entry.qualified}`,
      name: entry.qualified,
      entry,
      reason: 'nothing in this repository calls it, and it calls other declarations',
      steps,
      symbolIds: [entryId, ...steps.map((step) => step.id)],
      depth: steps.reduce((deepest, step) => Math.max(deepest, step.depth), 0),
      truncated,
    };
    processes.push(process);
    byId.set(process.id, process);
    for (const symbolId of process.symbolIds) {
      const list = bySymbol.get(symbolId);
      if (list) list.push(process.id);
      else bySymbol.set(symbolId, [process.id]);
    }
    const key = process.name.toLowerCase();
    const named = byName.get(key);
    if (named) named.push(process.id);
    else byName.set(key, [process.id]);
  }

  processes.sort((a, b) => b.steps.length - a.steps.length || a.name.localeCompare(b.name));
  return {
    processes,
    byId,
    bySymbol,
    byName,
    entryPoints: entries.length,
    truncated: entries.length > maxProcesses,
  };
}

export type ProcessResolution =
  | { status: 'ok'; id: string }
  | { status: 'ambiguous'; candidates: Array<{ id: string; name: string; filePath: string; steps: number }> }
  | { status: 'not_found'; suggestions: Array<{ id: string; name: string; filePath: string; steps: number }> };

const brief = (process: Process) => ({
  id: process.id,
  name: process.name,
  filePath: process.entry.filePath,
  steps: process.steps.length,
});

/** The flow a question names -- or every flow that name fits, ranked. */
export function resolveProcess(index: ProcessIndex, name: string): ProcessResolution {
  const raw = (name ?? '').trim();
  if (!raw) return { status: 'not_found', suggestions: [] };
  if (index.byId.has(raw)) return { status: 'ok', id: raw };
  if (index.byId.has(`Process:${raw}`)) return { status: 'ok', id: `Process:${raw}` };

  const exact = index.byName.get(raw.toLowerCase()) ?? [];
  if (exact.length === 1) return { status: 'ok', id: exact[0]! };
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exact.map((id) => brief(index.byId.get(id)!))
        .sort((a, b) => b.steps - a.steps || a.filePath.localeCompare(b.filePath)),
    };
  }

  // A name that is not a flow is often a declaration inside one, which is the
  // more useful thing to say: not "no such flow" but "it runs in these".
  const needle = raw.toLowerCase();
  const byEntry = index.processes.filter((process) => process.name.toLowerCase().includes(needle)
    || process.entry.filePath.toLowerCase().includes(needle));
  const byStep = index.processes.filter((process) => !byEntry.includes(process)
    && process.steps.some((step) => step.qualified.toLowerCase() === needle));
  return { status: 'not_found', suggestions: [...byEntry, ...byStep].slice(0, 5).map(brief) };
}

/** The flows a declaration takes part in, with where in each it sits. */
export function processesFor(
  index: ProcessIndex,
  symbolIds: Iterable<string>,
): Array<{ id: string; name: string; filePath: string; steps: number; entry: SymbolRef; depth: number | null }> {
  const found = new Map<string, number | null>();
  for (const symbolId of symbolIds) {
    for (const processId of index.bySymbol.get(symbolId) ?? []) {
      const process = index.byId.get(processId)!;
      const depth = process.entry.id === symbolId
        ? 0
        : process.steps.find((step) => step.id === symbolId)?.depth ?? null;
      const known = found.get(processId);
      if (known === undefined || (depth !== null && (known === null || depth < known))) {
        found.set(processId, depth);
      }
    }
  }
  return [...found].map(([id, depth]) => {
    const process = index.byId.get(id)!;
    return { id, name: process.name, filePath: process.entry.filePath, steps: process.steps.length, entry: process.entry, depth };
  }).sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99) || b.steps - a.steps || a.name.localeCompare(b.name));
}
