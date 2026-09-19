import type { CodeIndex, SymbolRef } from './code.js';
import { symbolRef, isTestPath } from './code.js';
import type { Route } from './api.js';

/**
 * Several repositories, read as one system.
 *
 * A service calls another service over HTTP, and to both call graphs that call
 * is a function that returns a promise. The connection exists only in a string
 * on one side and a route on the other, which is why "what breaks if I change
 * this endpoint" is a question neither repository can answer alone.
 *
 * This joins them: outbound HTTP calls found in one repository, routes found
 * in another, matched on method and path. A match is a contract, reported with
 * the confidence its evidence deserves -- a literal path on both sides is a
 * good match, a path built from a template is a weaker one, and a call whose
 * URL is a variable is reported as unmatched rather than guessed at.
 */

export interface HttpCall {
  method: string;
  /** The path as written, with any origin stripped. Null when it is a variable. */
  path: string | null;
  file: string;
  line: number;
  caller: SymbolRef | null;
  confidence: number;
  source: string;
}

const CLIENTS: Array<{ name: string; regex: RegExp; method?: number; path: number }> = [
  // axios.get('http://host/x'), api.post(`/x/${id}`), http.delete('/x')
  { name: 'client-method', regex: /\b(?:axios|api|http|client|request)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(['"`])([^'"`]*)\2/i, method: 1, path: 3 },
  // fetch('/x', { method: 'POST' })
  { name: 'fetch', regex: /\bfetch\s*\(\s*(['"`])([^'"`]*)\1(?:\s*,\s*\{[^}]*method\s*:\s*(['"`])(\w+)\3)?/i, path: 2 },
  // requests.get("http://host/x") / httpx.post(...)
  { name: 'python-requests', regex: /\b(?:requests|httpx|session)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(['"])([^'"]*)\2/i, method: 1, path: 3 },
  // http.NewRequest("GET", "http://host/x", ...)
  { name: 'go-request', regex: /\bNewRequest\s*\(\s*"(\w+)"\s*,\s*"([^"]*)"/, method: 1, path: 2 },
];

/** A call whose URL is a variable: recognised, and reported as unknown. */
const DYNAMIC_CALL = /\b(?:fetch|axios|requests|httpx)\s*(?:\.\s*\w+\s*)?\(\s*[A-Za-z_$][\w$.]*\s*[,)]/;

/** `https://host/api/users?x=1` -> `/api/users`. */
export function pathOf(url: string): string | null {
  const withoutOrigin = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const withoutQuery = withoutOrigin.split(/[?#]/)[0] ?? '';
  if (!withoutQuery.startsWith('/')) return withoutQuery ? `/${withoutQuery}` : null;
  return withoutQuery;
}

/** Placeholders on both sides collapse to the same token, so they can match. */
export function normalisePath(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z_]\w*/g, '*')
    .replace(/\{[^}]*\}/g, '*')
    .replace(/<[^>]*>/g, '*')
    .replace(/\/+$/, '')
    .toLowerCase() || '/';
}

export interface HttpCallOptions {
  read: (file: string) => string | undefined;
  includeTests?: boolean;
}

/** Every outbound HTTP call a repository makes, as far as a pattern can see one. */
export function httpCalls(index: CodeIndex, options: HttpCallOptions): HttpCall[] {
  const includeTests = options.includeTests ?? false;
  const files = new Set<string>();
  for (const symbol of index.symbols.values()) {
    if (includeTests || !isTestPath(symbol.filePath)) files.add(symbol.filePath);
  }

  const enclosing = (file: string, line: number): SymbolRef | null => {
    let best: { id: string; span: number } | null = null;
    for (const [id, symbol] of index.symbols) {
      if (symbol.filePath !== file) continue;
      if (line < symbol.startLine || line > symbol.endLine) continue;
      const span = symbol.endLine - symbol.startLine;
      if (!best || span < best.span) best = { id, span };
    }
    return best ? symbolRef(index, best.id) : null;
  };

  const calls: HttpCall[] = [];
  for (const file of files) {
    const text = options.read(file);
    if (text === undefined) continue;
    text.split(/\r?\n/).forEach((source, i) => {
      const line = i + 1;
      for (const client of CLIENTS) {
        const match = client.regex.exec(source);
        if (!match) continue;
        const raw = match[client.path];
        if (raw === undefined) continue;
        const path = pathOf(raw);
        const method = client.method !== undefined
          ? match[client.method]
          : /method\s*:\s*['"`](\w+)['"`]/i.exec(source)?.[1] ?? 'GET';
        calls.push({
          method: (method ?? 'GET').toUpperCase(),
          path,
          file,
          line,
          caller: enclosing(file, line),
          confidence: raw.includes('${') ? 0.6 : 0.85,
          source: source.trim().slice(0, 160),
        });
        return;
      }
      if (DYNAMIC_CALL.test(source)) {
        calls.push({
          method: 'ANY',
          path: null,
          file,
          line,
          caller: enclosing(file, line),
          confidence: 0.3,
          source: source.trim().slice(0, 160),
        });
      }
    });
  }
  return calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// contracts

export interface RepoSurface {
  repo: string;
  routes: Route[];
  calls: HttpCall[];
}

export interface Contract {
  consumer: { repo: string; file: string; line: number; caller: string | null; method: string; path: string };
  provider: { repo: string; file: string; line: number; handler: string | null; method: string; path: string };
  confidence: number;
  /** Why these two were matched. */
  basis: string;
}

export interface ContractReport {
  status: 'ok';
  contracts: Contract[];
  /** Calls that matched no route anywhere in the group. */
  unmatched: Array<{ repo: string; file: string; line: number; method: string; path: string | null; reason: string }>;
  summary: { repos: string[]; contracts: number; calls: number; routes: number; unmatched: number };
  limits: string[];
}

/**
 * Which repository answers which call.
 *
 * Method and path, with placeholders on both sides collapsed to a wildcard so
 * `/users/:id` and `` `/users/${id}` `` are the same path. A call that matches
 * a route in its own repository is still a contract -- a service may well call
 * itself over HTTP -- and it is reported with the repository named, so it can
 * be told from a cross-service one.
 */
export function contracts(surfaces: RepoSurface[]): ContractReport {
  const routes: Array<{ repo: string; route: Route; key: string }> = [];
  for (const surface of surfaces) {
    for (const route of surface.routes) {
      if (route.path === null) continue;
      routes.push({ repo: surface.repo, route, key: `${route.method} ${normalisePath(route.path)}` });
    }
  }

  const found: Contract[] = [];
  const unmatched: ContractReport['unmatched'] = [];
  let callCount = 0;

  for (const surface of surfaces) {
    for (const call of surface.calls) {
      callCount += 1;
      if (call.path === null) {
        unmatched.push({
          repo: surface.repo, file: call.file, line: call.line, method: call.method, path: null,
          reason: 'the URL is a variable, so there is nothing to match',
        });
        continue;
      }
      const wanted = normalisePath(call.path);
      const matches = routes.filter(({ route, key }) =>
        key === `${call.method} ${wanted}`
        || (route.method === 'ANY' && key === `ANY ${wanted}`)
        || (call.method === 'ANY' && key.endsWith(` ${wanted}`)));
      if (matches.length === 0) {
        unmatched.push({
          repo: surface.repo, file: call.file, line: call.line, method: call.method, path: call.path,
          reason: 'no repository in this group declares that route',
        });
        continue;
      }
      for (const match of matches) {
        found.push({
          consumer: {
            repo: surface.repo, file: call.file, line: call.line,
            caller: call.caller?.qualified ?? null, method: call.method, path: call.path,
          },
          provider: {
            repo: match.repo, file: match.route.file, line: match.route.line,
            handler: match.route.handler?.qualified ?? null, method: match.route.method, path: match.route.path!,
          },
          confidence: Number((call.confidence * match.route.confidence).toFixed(2)),
          basis: `${call.method} ${call.path} matches ${match.route.method} ${match.route.path} once placeholders on both sides are collapsed`,
        });
      }
    }
  }

  found.sort((a, b) => b.confidence - a.confidence || a.consumer.repo.localeCompare(b.consumer.repo));
  return {
    status: 'ok',
    contracts: found,
    unmatched,
    summary: {
      repos: surfaces.map((surface) => surface.repo),
      contracts: found.length,
      calls: callCount,
      routes: routes.length,
      unmatched: unmatched.length,
    },
    limits: [
      'Contracts are matched on method and path alone. Nothing here checks that the body a caller sends is the body the route expects.',
      'A call whose URL is built at runtime cannot be matched and is listed as unmatched rather than left out.',
      'Only the repositories in this group were looked at: a call answered by a service outside it is unmatched, which is not the same as broken.',
    ],
  };
}
