import type { CodeIndex, SymbolRef } from './code.js';
import { symbolRef, isTestPath } from './code.js';

/**
 * The HTTP surface a repository exposes, and what sits behind it.
 *
 * A call graph answers questions about declarations. The question a service
 * gets asked is different: which endpoints exist, and which of them does this
 * change touch. Routes are how a codebase is described to everyone outside it,
 * and nothing in the graph records them, because a route is a string passed to
 * a framework.
 *
 * So they are read from the source text, per framework, with a pattern each.
 * That is a weaker instrument than the graph and it says so: every route
 * carries the framework it was recognised as and a confidence, a route built
 * from a variable is reported as unresolved rather than guessed at, and the
 * frameworks that were looked for are part of the answer so an empty list can
 * be told from a framework nobody wrote a pattern for.
 */

export interface Route {
  method: string;
  /** As written in the source. A path built from a variable is reported as `null`. */
  path: string | null;
  framework: string;
  file: string;
  line: number;
  /** The declaration the route is declared inside, when there is one. */
  handler: SymbolRef | null;
  /** How the route was recognised: a literal string, or a name that may be anything. */
  confidence: number;
  /** The text the pattern matched, so a person can check it. */
  source: string;
}

export interface RouteMap {
  status: 'ok';
  routes: Route[];
  summary: {
    routes: number;
    frameworks: string[];
    unresolvedPaths: number;
    filesScanned: number;
    /** Every framework a pattern exists for, so nothing reads as "no routes". */
    frameworksLookedFor: string[];
  };
  limits: string[];
}

interface Pattern {
  framework: string;
  /** Must capture (method, path) or use `method` when the pattern fixes it. */
  regex: RegExp;
  method?: string;
  /** Which capture group holds what. */
  groups: { method?: number; path: number };
  confidence: number;
}

const HTTP_METHODS = 'get|post|put|patch|delete|head|options|all';

/**
 * One pattern per framework, deliberately shallow.
 *
 * These read a line, not a syntax tree: they find the shape a framework's
 * routes are written in and nothing more. A route assembled at runtime, or
 * registered through a helper of the project's own, is invisible here -- which
 * is why the answer says what it looked for.
 */
const PATTERNS: Pattern[] = [
  {
    // app.get('/users', handler) -- Express, Koa router, Fastify, Gin, Echo.
    framework: 'express-style',
    regex: new RegExp(`\\b(?:app|router|server|r|e|fastify|api)\\s*\\.\\s*(${HTTP_METHODS})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'i'),
    groups: { method: 1, path: 3 },
    confidence: 0.9,
  },
  {
    // http.HandleFunc("/users", handler) -- Go's standard library.
    framework: 'go-net-http',
    regex: /\b(?:http|mux|s)\s*\.\s*Handle(?:Func)?\s*\(\s*"([^"]*)"/,
    method: 'ANY',
    groups: { path: 1 },
    confidence: 0.85,
  },
  {
    // @app.get("/users") / @router.post("/users") -- FastAPI.
    framework: 'fastapi',
    regex: new RegExp(`@\\s*(?:app|router|api)\\s*\\.\\s*(${HTTP_METHODS})\\s*\\(\\s*(['"])([^'"]*)\\2`, 'i'),
    groups: { method: 1, path: 3 },
    confidence: 0.9,
  },
  {
    // @app.route("/users", methods=["POST"]) -- Flask.
    framework: 'flask',
    regex: /@\s*(?:app|bp|blueprint)\s*\.\s*route\s*\(\s*(['"])([^'"]*)\1(?:[^)]*methods\s*=\s*\[([^\]]*)\])?/i,
    groups: { path: 2, method: 3 },
    confidence: 0.9,
  },
  {
    // path('users/', view) / re_path(r'^users/$', view) -- Django.
    framework: 'django',
    regex: /\b(?:re_)?path\s*\(\s*r?(['"])([^'"]*)\1/,
    method: 'ANY',
    groups: { path: 2 },
    confidence: 0.8,
  },
  {
    // @Get('/users') -- NestJS; @GetMapping("/users") -- Spring.
    framework: 'decorator',
    regex: new RegExp(`@\\s*(${HTTP_METHODS})(?:Mapping)?\\s*\\(\\s*(['"])([^'"]*)\\2`, 'i'),
    groups: { method: 1, path: 3 },
    confidence: 0.85,
  },
  {
    // [HttpGet("users")] -- ASP.NET.
    framework: 'aspnet',
    regex: new RegExp(`\\[\\s*Http(${HTTP_METHODS})\\s*\\(\\s*"([^"]*)"`, 'i'),
    groups: { method: 1, path: 2 },
    confidence: 0.85,
  },
  {
    // get '/users' => 'users#index' -- Rails routes.
    framework: 'rails',
    regex: new RegExp(`^\\s*(${HTTP_METHODS})\\s+(['"])([^'"]*)\\2`, 'i'),
    groups: { method: 1, path: 3 },
    confidence: 0.7,
  },
];

export const FRAMEWORKS = [...new Set(PATTERNS.map((pattern) => pattern.framework))];

/** A route written with a variable instead of a literal, so the path is unknown. */
const DYNAMIC = new RegExp(`\\b(?:app|router|server|fastify|api)\\s*\\.\\s*(${HTTP_METHODS})\\s*\\(\\s*[A-Za-z_$][\\w$.]*\\s*[,)]`, 'i');

/**
 * The declaration a route line belongs to.
 *
 * Usually the one whose range contains it, innermost first. A decorated route
 * -- NestJS, FastAPI, Flask, Spring -- is written *above* its handler instead,
 * so a line inside nothing takes the declaration that starts just below it.
 * Without that, every decorator framework reports its routes as having no
 * handler, and nothing connects them to the call graph.
 */
const DECORATOR_REACH = 3;

function enclosing(index: CodeIndex, file: string, line: number): SymbolRef | null {
  let best: { id: string; span: number } | null = null;
  let below: { id: string; distance: number } | null = null;

  for (const [id, symbol] of index.symbols) {
    if (symbol.filePath !== file) continue;
    if (line >= symbol.startLine && line <= symbol.endLine) {
      const span = symbol.endLine - symbol.startLine;
      if (!best || span < best.span) best = { id, span };
      continue;
    }
    const distance = symbol.startLine - line;
    if (distance > 0 && distance <= DECORATOR_REACH && (!below || distance < below.distance)) {
      below = { id, distance };
    }
  }

  if (best) return symbolRef(index, best.id);
  return below ? symbolRef(index, below.id) : null;
}

export interface RouteOptions {
  read: (file: string) => string | undefined;
  includeTests?: boolean;
}

/** Every route this repository declares, as far as a pattern can see one. */
export function routeMap(index: CodeIndex, options: RouteOptions): RouteMap {
  const includeTests = options.includeTests ?? false;
  const files = new Set<string>();
  for (const symbol of index.symbols.values()) {
    if (includeTests || !isTestPath(symbol.filePath)) files.add(symbol.filePath);
  }
  for (const file of index.importsOut.keys()) {
    if (includeTests || !isTestPath(file)) files.add(file);
  }

  const routes: Route[] = [];
  let unresolved = 0;
  let scanned = 0;

  for (const file of files) {
    const text = options.read(file);
    if (text === undefined) continue;
    scanned += 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((source, i) => {
      const line = i + 1;
      for (const pattern of PATTERNS) {
        const match = pattern.regex.exec(source);
        if (!match) continue;
        const path = match[pattern.groups.path];
        if (path === undefined) continue;
        const method = pattern.method
          ?? (pattern.groups.method !== undefined ? match[pattern.groups.method] : undefined)
          ?? 'ANY';
        routes.push({
          method: method.replace(/['"\s]/g, '').toUpperCase() || 'ANY',
          path,
          framework: pattern.framework,
          file,
          line,
          handler: enclosing(index, file, line),
          confidence: pattern.confidence,
          source: source.trim().slice(0, 160),
        });
        break;
      }
      if (DYNAMIC.test(source) && !routes.some((route) => route.file === file && route.line === line)) {
        unresolved += 1;
        routes.push({
          method: (DYNAMIC.exec(source)?.[1] ?? 'ANY').toUpperCase(),
          path: null,
          framework: 'express-style',
          file,
          line,
          handler: enclosing(index, file, line),
          confidence: 0.4,
          source: source.trim().slice(0, 160),
        });
      }
    });
  }

  routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const frameworks = [...new Set(routes.map((route) => route.framework))].sort();
  return {
    status: 'ok',
    routes,
    summary: {
      routes: routes.length,
      frameworks,
      unresolvedPaths: unresolved,
      filesScanned: scanned,
      frameworksLookedFor: FRAMEWORKS,
    },
    limits: [
      'Routes are read from the source text one line at a time, not from a syntax tree: a route registered through a helper of this project, or assembled at runtime, is not here.',
      `Patterns exist for: ${FRAMEWORKS.join(', ')}. A framework not in that list produces no routes, which is not the same as a repository having none.`,
      ...(unresolved > 0 ? [`${unresolved} route(s) are declared with a variable instead of a literal path, and are listed with no path rather than a guess.`] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// shape_check

export interface RouteProblem {
  kind: 'duplicate' | 'unbound-parameter' | 'no-handler';
  message: string;
  routes: Array<{ method: string; path: string | null; file: string; line: number }>;
}

export interface ShapeCheckResult {
  status: 'ok';
  problems: RouteProblem[];
  summary: { routes: number; problems: number; checked: string[] };
}

/** `/users/:id`, `/users/{id}`, `/users/<int:id>` -- the names a path binds. */
function parametersOf(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(/:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)[^}]*\}|<(?:[^:>]+:)?([A-Za-z_]\w*)>/g)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.push(name);
  }
  return names;
}

/**
 * What is wrong with the routes themselves.
 *
 * Three things a route map can show without understanding the framework: the
 * same method and path declared twice, a path parameter the handler never
 * mentions, and a route declared outside any declaration this graph knows.
 * Each one is a question for a person, not a verdict -- a framework may well
 * take the second registration, and a parameter may be read from a context
 * object this cannot see.
 */
export function shapeCheck(map: RouteMap, options: { read: (file: string) => string | undefined }): ShapeCheckResult {
  const problems: RouteProblem[] = [];

  const byKey = new Map<string, Route[]>();
  for (const route of map.routes) {
    if (route.path === null) continue;
    const key = `${route.method} ${route.path}`;
    const list = byKey.get(key);
    if (list) list.push(route);
    else byKey.set(key, [route]);
  }
  for (const [key, routes] of byKey) {
    if (routes.length < 2) continue;
    problems.push({
      kind: 'duplicate',
      message: `${key} is declared ${routes.length} times. Which one answers depends on the framework's registration order.`,
      routes: routes.map(({ method, path, file, line }) => ({ method, path, file, line })),
    });
  }

  for (const route of map.routes) {
    if (route.path === null) continue;
    const parameters = parametersOf(route.path);
    if (parameters.length === 0) continue;
    const handler = route.handler;
    const text = options.read(route.file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    const from = handler ? handler.startLine - 1 : route.line - 1;
    const to = handler ? handler.endLine : Math.min(lines.length, route.line + 20);
    const body = lines.slice(from, to).join('\n');
    const missing = parameters.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
    if (missing.length > 0) {
      problems.push({
        kind: 'unbound-parameter',
        message: `${route.method} ${route.path} binds ${missing.join(', ')}, and the handler does not mention ${missing.length > 1 ? 'them' : 'it'}. It may be read from a request object this cannot see.`,
        routes: [{ method: route.method, path: route.path, file: route.file, line: route.line }],
      });
    }
    if (!handler) {
      problems.push({
        kind: 'no-handler',
        message: `${route.method} ${route.path} is declared outside any indexed declaration, so nothing connects it to the code graph.`,
        routes: [{ method: route.method, path: route.path, file: route.file, line: route.line }],
      });
    }
  }

  return {
    status: 'ok',
    problems,
    summary: {
      routes: map.routes.length,
      problems: problems.length,
      checked: ['duplicate method and path', 'path parameters the handler never mentions', 'routes with no indexed handler'],
    },
  };
}

// ---------------------------------------------------------------------------
// api_impact

export interface ApiImpactResult {
  status: 'ok';
  target: SymbolRef;
  routes: Array<{ method: string; path: string | null; file: string; line: number; depth: number; handler: string | null }>;
  summary: { routes: number; searchedDepth: number; note: string };
}

/**
 * Which endpoints a change is visible through.
 *
 * Walks callers upwards from the target and reports every route whose handler
 * is one of them, with how many calls away it is. A route reached at depth
 * three is still a route whose answer can change.
 */
export function apiImpact(
  index: CodeIndex,
  map: RouteMap,
  targetId: string,
  options: { maxDepth?: number; includeTests?: boolean } = {},
): ApiImpactResult {
  const maxDepth = Math.max(1, Math.min(8, Math.floor(options.maxDepth ?? 5)));
  const includeTests = options.includeTests ?? false;

  const depthOf = new Map<string, number>([[targetId, 0]]);
  let frontier = [targetId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const sources = [id, ...(index.parent.has(id) ? [index.parent.get(id)!] : [])];
      for (const source of sources) {
        for (const edge of index.callsIn.get(source) ?? []) {
          if (depthOf.has(edge.to)) continue;
          const symbol = index.symbols.get(edge.to);
          if (!symbol) continue;
          if (!includeTests && isTestPath(symbol.filePath)) continue;
          depthOf.set(edge.to, depth);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }

  const routes = map.routes
    .filter((route) => route.handler && depthOf.has(route.handler.id))
    .map((route) => ({
      method: route.method,
      path: route.path,
      file: route.file,
      line: route.line,
      depth: depthOf.get(route.handler!.id)!,
      handler: route.handler!.qualified,
    }))
    .sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || a.line - b.line);

  return {
    status: 'ok',
    target: symbolRef(index, targetId),
    routes,
    summary: {
      routes: routes.length,
      searchedDepth: maxDepth,
      note: routes.length === 0
        ? 'No route in this repository reaches this declaration within the depth searched. A route registered in a way the patterns do not recognise would not be found either.'
        : `${routes.length} endpoint(s) answer through this declaration.`,
    },
  };
}

// ---------------------------------------------------------------------------
// tool_map

export interface ToolDefinition {
  name: string;
  file: string;
  line: number;
  /** How it was recognised. */
  style: 'mcp-sdk-object' | 'python-decorator' | 'python-tool-object';
  description: string | null;
}

export interface ToolMap {
  status: 'ok';
  tools: ToolDefinition[];
  summary: { tools: number; filesScanned: number; stylesLookedFor: string[] };
}

/**
 * The MCP tools this repository defines.
 *
 * An agent asking "what can this server do" gets the answer from the server
 * itself. This is the other question: which tools does this codebase declare,
 * and where, so a change to one can be found from its name.
 */
export function toolMap(index: CodeIndex, options: RouteOptions): ToolMap {
  const includeTests = options.includeTests ?? false;
  const files = new Set<string>();
  for (const symbol of index.symbols.values()) {
    if (includeTests || !isTestPath(symbol.filePath)) files.add(symbol.filePath);
  }

  const tools: ToolDefinition[] = [];
  let scanned = 0;
  for (const file of files) {
    const text = options.read(file);
    if (text === undefined) continue;
    scanned += 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((source, i) => {
      // { name: 'x', description: ..., inputSchema: ... } -- the SDK's shape.
      const sdk = /^\s*name:\s*(['"`])([\w.-]+)\1\s*,?\s*$/.exec(source);
      if (sdk) {
        const near = lines.slice(i, Math.min(lines.length, i + 12)).join('\n');
        if (/inputSchema/.test(near)) {
          const described = /description:\s*(?:\n\s*)?(['"`])([\s\S]{0,120}?)\1/.exec(near);
          tools.push({ name: sdk[2]!, file, line: i + 1, style: 'mcp-sdk-object', description: described?.[2]?.trim() ?? null });
          return;
        }
      }
      // @mcp.tool() / @server.tool("name")
      const decorator = /@\s*(?:mcp|server|app)\s*\.\s*tool\s*\(\s*(?:(['"])([\w.-]+)\1)?/.exec(source);
      if (decorator) {
        const following = lines.slice(i + 1, Math.min(lines.length, i + 4)).join('\n');
        const named = decorator[2] ?? /def\s+(\w+)/.exec(following)?.[1] ?? null;
        if (named) tools.push({ name: named, file, line: i + 1, style: 'python-decorator', description: null });
        return;
      }
      // types.Tool(name="x", ...)
      const object = /Tool\s*\(\s*name\s*=\s*(['"])([\w.-]+)\1/.exec(source);
      if (object) tools.push({ name: object[2]!, file, line: i + 1, style: 'python-tool-object', description: null });
    });
  }

  tools.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
  return {
    status: 'ok',
    tools,
    summary: {
      tools: tools.length,
      filesScanned: scanned,
      stylesLookedFor: ['an object with name and inputSchema (the MCP SDK)', '@mcp.tool() and @server.tool("name")', 'Tool(name="...")'],
    },
  };
}
