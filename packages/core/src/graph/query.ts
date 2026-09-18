import type { MemoryStore } from '../store/store.js';
import type { CodeIndex, SymbolRef } from './code.js';
import { isTestPath, symbolRef } from './code.js';
import type { ProcessIndex } from './process.js';
import { tokenize } from '../util/tokenize.js';

/**
 * Asking the code graph a question in words, answered by execution flow.
 *
 * Grep answers with lines. This answers with the flows those lines sit in,
 * because the useful reply to "where does retrying a declined card happen" is
 * the handler and the path it takes, not forty files that contain the word
 * "retry". Declarations that match but belong to no flow are still returned,
 * in their own group: unreachable code is an answer, and dropping it would
 * quietly hide the thing being looked for. That group means "no flow that was
 * built reaches this" -- either nothing reaches it, or the flow that would
 * have stopped at its own step limit first.
 */

export interface QueryHit extends SymbolRef {
  score: number;
  /** Which part of the declaration the query matched. */
  matched: Array<'name' | 'path'>;
}

export interface QueryGroup {
  process: { id: string; name: string; filePath: string; steps: number } | null;
  hits: QueryHit[];
  score: number;
  memories: Array<{ id: string; title: string; layer: string; sourceRef: string | null }>;
}

export interface QueryResult {
  status: 'ok';
  query: string;
  terms: string[];
  groups: QueryGroup[];
  summary: {
    symbols: number;
    processes: number;
    unassigned: number;
    testsSkipped: number;
  };
}

export interface QueryOptions {
  limit?: number;
  includeTests?: boolean;
}

/** `chargeCardTwice` and `charge_card_twice` both split into their words. */
function words(text: string): string[] {
  return tokenize(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-./\\]+/g, ' '));
}

/**
 * How well one declaration answers the query.
 *
 * A term found in the name counts for more than the same term found in the
 * path: a file called `billing.ts` says what is nearby, while a function called
 * `retryCharge` says what the code does.
 */
function score(terms: string[], name: string[], path: string[]): { score: number; matched: QueryHit['matched'] } {
  const inName = new Set(name);
  const inPath = new Set(path);
  const matched = new Set<'name' | 'path'>();
  let total = 0;
  for (const term of terms) {
    if (inName.has(term)) {
      total += 1;
      matched.add('name');
    } else if (inPath.has(term)) {
      total += 0.4;
      matched.add('path');
    } else if (name.some((word) => word.startsWith(term) || term.startsWith(word))) {
      total += 0.5;
      matched.add('name');
    }
  }
  return { score: Number((total / terms.length).toFixed(4)), matched: [...matched] };
}

export async function query(
  store: MemoryStore,
  index: CodeIndex,
  processes: ProcessIndex,
  text: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  const includeTests = options.includeTests ?? false;
  const terms = words(text);
  if (terms.length === 0) {
    return {
      status: 'ok',
      query: text,
      terms,
      groups: [],
      summary: { symbols: 0, processes: 0, unassigned: 0, testsSkipped: 0 },
    };
  }

  const hits: QueryHit[] = [];
  let testsSkipped = 0;
  for (const [id, symbol] of index.symbols) {
    if (!includeTests && isTestPath(symbol.filePath)) {
      testsSkipped += 1;
      continue;
    }
    const ref = symbolRef(index, id);
    const scored = score(terms, words(ref.qualified), words(ref.filePath));
    if (scored.score <= 0) continue;
    hits.push({ ...ref, score: scored.score, matched: scored.matched });
  }
  hits.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
  const top = hits.slice(0, limit);

  const grouped = new Map<string, QueryHit[]>();
  const loose: QueryHit[] = [];
  for (const hit of top) {
    const ids = processes.bySymbol.get(hit.id) ?? [];
    if (ids.length === 0) {
      loose.push(hit);
      continue;
    }
    for (const processId of ids) {
      const list = grouped.get(processId);
      if (list) list.push(hit);
      else grouped.set(processId, [hit]);
    }
  }

  const groups: QueryGroup[] = [];
  for (const [processId, groupHits] of grouped) {
    const process = processes.byId.get(processId)!;
    groups.push({
      process: { id: process.id, name: process.name, filePath: process.entry.filePath, steps: process.steps.length },
      hits: groupHits,
      score: Number(Math.max(...groupHits.map((hit) => hit.score)).toFixed(4)),
      memories: [],
    });
  }
  groups.sort((a, b) => b.score - a.score || b.hits.length - a.hits.length);
  if (loose.length > 0) {
    groups.push({
      process: null,
      hits: loose,
      score: Number(Math.max(...loose.map((hit) => hit.score)).toFixed(4)),
      memories: [],
    });
  }

  // What was recorded about the declarations that matched. Anchored by id, so
  // this costs one query and needs no embedding model.
  for (const group of groups) {
    const about = await store.nodesAboutSymbolIds(group.hits.map((hit) => hit.id), 5);
    group.memories = about.map((node) => ({
      id: node.id, title: node.title, layer: node.layer, sourceRef: node.sourceRef ?? null,
    }));
  }

  return {
    status: 'ok',
    query: text,
    terms,
    groups,
    summary: {
      symbols: top.length,
      processes: groups.filter((group) => group.process !== null).length,
      unassigned: loose.length,
      testsSkipped,
    },
  };
}
