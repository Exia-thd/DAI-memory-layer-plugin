import type { CodeIndex, SymbolRef } from './code.js';
import { symbolRef, isTestPath } from './code.js';

/**
 * Where untrusted input can reach something dangerous.
 *
 * This is pattern matching over the text of each declaration, joined up by the
 * call graph -- not data-flow analysis. It knows that a declaration mentions
 * `req.query` and that something it calls runs `exec`, and it says so; it does
 * not know whether the value in the exec call is the one that came from the
 * query. That distinction is the whole difference between this and a security
 * tool, and every finding carries it: a confidence, the marker that matched,
 * and the sanitizer seen on the way if there was one.
 *
 * It is written this way on purpose. A taint analysis that claims certainty it
 * does not have gets ignored after the third false positive, and one that says
 * "these four places are worth ten minutes" gets used.
 */

export interface Marker {
  name: string;
  pattern: RegExp;
  /** What kind of trouble it is, in words a person can act on. */
  kind: string;
}

/** Untrusted input: what a caller, a user or the network controls. */
export const SOURCES: Marker[] = [
  { name: 'http-request', kind: 'an HTTP request body, query or parameters', pattern: /\b(?:req|request|ctx)\s*\.\s*(?:body|query|params|param|args|form|json|cookies|headers)\b/i },
  { name: 'flask-request', kind: 'a Flask or Django request', pattern: /\brequest\s*\.\s*(?:args|form|json|values|data|GET|POST|FILES)\b/ },
  { name: 'cli-arguments', kind: 'command-line arguments', pattern: /\b(?:process\s*\.\s*argv|sys\s*\.\s*argv|os\.Args)\b/ },
  { name: 'environment', kind: 'the environment', pattern: /\b(?:process\s*\.\s*env|os\s*\.\s*environ|os\.Getenv)\b/ },
  { name: 'stdin', kind: 'standard input', pattern: /\b(?:input\s*\(|readline\s*\(|stdin\b|Scanner\s*\()/ },
  { name: 'event-payload', kind: 'an event payload', pattern: /\bevent\s*\.\s*(?:body|queryStringParameters|pathParameters)\b/ },
  { name: 'file-upload', kind: 'an uploaded file', pattern: /\b(?:multer|req\.files|request\.files|FileUpload)\b/i },
];

/** Where untrusted input causes damage. */
export const SINKS: Marker[] = [
  { name: 'shell', kind: 'a shell command', pattern: /\b(?:child_process\s*\.\s*exec|execSync|spawnSync?\s*\(|os\.system|subprocess\.(?:call|run|Popen)|Runtime\.getRuntime\(\)\.exec|system\s*\()/ },
  { name: 'eval', kind: 'code evaluated at runtime', pattern: /\b(?:eval\s*\(|new\s+Function\s*\(|exec\s*\(|Function\s*\(\s*['"`])/ },
  { name: 'sql', kind: 'a database query', pattern: /\b(?:query|execute|executeQuery|raw|rawQuery)\s*\(\s*(?:[`'"][^`'"]*(?:SELECT|INSERT|UPDATE|DELETE)|.*\+)/i },
  { name: 'html', kind: 'HTML rendered in a browser', pattern: /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write)\b/ },
  { name: 'filesystem', kind: 'a path on disk', pattern: /\b(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream|open\s*\(|unlink|rmSync|remove\s*\()/ },
  { name: 'redirect', kind: 'a redirect', pattern: /\b(?:res|response|ctx)\s*\.\s*redirect\s*\(/ },
  { name: 'deserialize', kind: 'deserialization', pattern: /\b(?:pickle\.loads|yaml\.load\s*\(|unserialize\s*\(|ObjectInputStream)/ },
  // Anchored to where a call can actually stand. Unanchored, this matched the
  // words "import(s)" inside an English sentence in a log message and reported
  // a module load: prose in a string literal is the commonest false positive a
  // line-based scan makes, and the cheapest to rule out.
  { name: 'dynamic-import', kind: 'a module loaded by name', pattern: /(?:^|[=;{(]\s*|\b(?:await|return|yield)\s+)(?:require|import)\s*\(\s*[A-Za-z_$][\w$.]*\s*\)/ },
];

/** What makes input safe enough to pass on. */
export const SANITIZERS: Marker[] = [
  // Matches the family, not the exact name: a project's own `escapeArg` or
  // `sanitizeInput` is a sanitizer, and requiring the bare word meant the
  // commonest case -- a helper named after what it does -- was missed.
  { name: 'escaping', kind: 'escaping', pattern: /\b(?:escape|sanitiz|sanitis|encodeURI|quote|shlex\.quote|html\.escape)\w*\s*\(/i },
  { name: 'validation', kind: 'validation', pattern: /\b(?:validator\.|zod|joi\.|yup\.|\.safeParse\s*\(|\.parse\s*\(|isUUID|isEmail|matches\s*\()/i },
  { name: 'typing', kind: 'a conversion that rejects anything else', pattern: /\b(?:parseInt\s*\(|parseFloat\s*\(|Number\s*\(|int\s*\(|float\s*\(|uuid\.UUID\s*\()/ },
  { name: 'path-confinement', kind: 'confining a path', pattern: /\b(?:path\.basename|path\.resolve|os\.path\.basename|filepath\.Clean)\s*\(/ },
  { name: 'parameterised-query', kind: 'a parameterised query', pattern: /(?:\?\s*,|\$\d|:\w+\s*[,)])\s*(?:\[|\()/ },
];

export interface MarkerHit {
  marker: string;
  kind: string;
  line: number;
  text: string;
}

export interface DeclarationMarkers {
  symbol: SymbolRef;
  sources: MarkerHit[];
  sinks: MarkerHit[];
  sanitizers: MarkerHit[];
}

function scan(markers: Marker[], lines: string[], startLine: number): MarkerHit[] {
  const hits: MarkerHit[] = [];
  lines.forEach((text, i) => {
    for (const marker of markers) {
      if (!marker.pattern.test(text)) continue;
      hits.push({ marker: marker.name, kind: marker.kind, line: startLine + i, text: text.trim().slice(0, 160) });
      break;
    }
  });
  return hits;
}

export interface TaintOptions {
  read: (file: string) => string | undefined;
  includeTests?: boolean;
  /** How many calls a source may travel from to reach a sink. */
  maxDepth?: number;
}

export interface TaintFinding {
  /** Where the untrusted value enters. */
  source: { symbol: SymbolRef; hit: MarkerHit };
  /** Where it could do damage. */
  sink: { symbol: SymbolRef; hit: MarkerHit };
  /** The calls between them. Empty when both are in the same declaration. */
  path: SymbolRef[];
  /** A sanitizer seen anywhere along the path, which is why a finding can be weak. */
  sanitizers: Array<{ symbol: SymbolRef; hit: MarkerHit }>;
  confidence: number;
  /** What this claims, and what it does not. */
  why: string;
}

export interface TaintResult {
  status: 'ok';
  findings: TaintFinding[];
  summary: {
    declarationsScanned: number;
    withSources: number;
    withSinks: number;
    findings: number;
    mitigated: number;
    maxDepth: number;
  };
  limits: string[];
}

/**
 * Sources joined to sinks through the call graph.
 *
 * A declaration holding both is the direct case. Otherwise the callees are
 * walked forwards to the depth asked: a handler that reads `req.query` and
 * calls something three steps down that runs a shell command is the finding
 * that matters, and it is invisible to anything looking at one function.
 *
 * Confidence falls with distance, because each call is another place the value
 * may be replaced entirely, and falls again when a sanitizer appears on the
 * way -- that path is reported as mitigated rather than dropped, because the
 * sanitizer may apply to something else.
 */
export function taint(index: CodeIndex, options: TaintOptions): TaintResult {
  const includeTests = options.includeTests ?? false;
  const maxDepth = Math.max(0, Math.min(6, Math.floor(options.maxDepth ?? 3)));

  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (!cache.has(file)) {
      const text = options.read(file);
      cache.set(file, text === undefined ? null : text.split(/\r?\n/));
    }
    return cache.get(file)!;
  };

  const markers = new Map<string, DeclarationMarkers>();
  let scanned = 0;
  for (const [id, symbol] of index.symbols) {
    if (!includeTests && isTestPath(symbol.filePath)) continue;
    const lines = linesOf(symbol.filePath);
    if (!lines) continue;
    const body = lines.slice(symbol.startLine - 1, symbol.endLine);
    if (body.length === 0) continue;
    scanned += 1;
    const found: DeclarationMarkers = {
      symbol: symbolRef(index, id),
      sources: scan(SOURCES, body, symbol.startLine),
      sinks: scan(SINKS, body, symbol.startLine),
      sanitizers: scan(SANITIZERS, body, symbol.startLine),
    };
    if (found.sources.length || found.sinks.length || found.sanitizers.length) markers.set(id, found);
  }

  const findings: TaintFinding[] = [];
  const seen = new Set<string>();

  for (const [id, entry] of markers) {
    if (entry.sources.length === 0) continue;

    // Breadth-first over callees, carrying the path and the sanitizers seen.
    let frontier: Array<{ id: string; path: string[]; sanitizers: Array<{ symbol: SymbolRef; hit: MarkerHit }> }> = [
      { id, path: [], sanitizers: entry.sanitizers.map((hit) => ({ symbol: entry.symbol, hit })) },
    ];
    const visited = new Set<string>([id]);

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const step of frontier) {
        const here = markers.get(step.id);
        if (here) {
          for (const sink of here.sinks) {
            for (const source of entry.sources) {
              // A source below its own sink in the same declaration is still
              // reported: line order is not execution order.
              const key = `${id}:${source.line}:${step.id}:${sink.line}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const distance = step.path.length;
              const mitigated = step.sanitizers.length > 0;
              const confidence = Number(Math.max(0.15, (0.75 - distance * 0.15) * (mitigated ? 0.5 : 1)).toFixed(2));
              findings.push({
                source: { symbol: entry.symbol, hit: source },
                sink: { symbol: here.symbol, hit: sink },
                path: step.path.map((pathId) => symbolRef(index, pathId)),
                sanitizers: step.sanitizers,
                confidence,
                why: mitigated
                  ? `${entry.symbol.qualified} reads ${source.kind} and ${distance === 0 ? 'the same declaration' : here.symbol.qualified} reaches ${sink.kind}; a sanitizer appears on the way, which may or may not apply to this value.`
                  : `${entry.symbol.qualified} reads ${source.kind} and ${distance === 0 ? 'the same declaration' : here.symbol.qualified} reaches ${sink.kind}. Whether the same value travels between them is not checked here.`,
              });
            }
          }
        }
        if (depth === maxDepth) continue;
        for (const edge of index.callsOut.get(step.id) ?? []) {
          if (visited.has(edge.to)) continue;
          const callee = index.symbols.get(edge.to);
          if (!callee) continue;
          if (!includeTests && isTestPath(callee.filePath)) continue;
          visited.add(edge.to);
          const calleeMarkers = markers.get(edge.to);
          next.push({
            id: edge.to,
            path: [...step.path, edge.to],
            sanitizers: [
              ...step.sanitizers,
              ...(calleeMarkers?.sanitizers ?? []).map((hit) => ({ symbol: calleeMarkers!.symbol, hit })),
            ],
          });
        }
      }
      frontier = next;
    }
  }

  findings.sort((a, b) => b.confidence - a.confidence
    || a.source.symbol.filePath.localeCompare(b.source.symbol.filePath)
    || a.source.hit.line - b.source.hit.line);

  const withSources = [...markers.values()].filter((entry) => entry.sources.length > 0).length;
  const withSinks = [...markers.values()].filter((entry) => entry.sinks.length > 0).length;
  return {
    status: 'ok',
    findings,
    summary: {
      declarationsScanned: scanned,
      withSources,
      withSinks,
      findings: findings.length,
      mitigated: findings.filter((finding) => finding.sanitizers.length > 0).length,
      maxDepth,
    },
    limits: [
      'This matches patterns in the text of each declaration and joins them through the call graph. It does not track values: a source and a sink in the same path do not have to be the same data.',
      `Sources looked for: ${SOURCES.map((marker) => marker.name).join(', ')}.`,
      `Sinks looked for: ${SINKS.map((marker) => marker.name).join(', ')}.`,
      'A sanitizer anywhere on the path halves the confidence and marks the finding mitigated; it is not dropped, because the sanitizer may apply to a different value.',
      'Nothing here is a vulnerability report. It is a list of places worth reading.',
    ],
  };
}

/**
 * What is known about one declaration or file, security first.
 *
 * `explain` in the sense the harness's skills use it: the taint findings that
 * touch it, and what the graph says about how it is reached.
 */
export interface ExplainResult {
  status: 'ok';
  target: SymbolRef | { file: string };
  findings: TaintFinding[];
  markers: DeclarationMarkers[];
  summary: { findings: number; asSource: number; asSink: number; onPath: number; note: string };
}

export function explain(
  index: CodeIndex,
  result: TaintResult,
  target: { symbolId?: string; file?: string },
  markersFor?: Map<string, DeclarationMarkers>,
): ExplainResult {
  const matches = (symbol: SymbolRef): boolean =>
    (target.symbolId !== undefined && symbol.id === target.symbolId)
    || (target.file !== undefined && symbol.filePath === target.file);

  const asSource = result.findings.filter((finding) => matches(finding.source.symbol));
  const asSink = result.findings.filter((finding) => matches(finding.sink.symbol));
  const onPath = result.findings.filter((finding) => finding.path.some(matches));
  const findings = [...new Set([...asSource, ...asSink, ...onPath])];

  return {
    status: 'ok',
    target: target.symbolId ? symbolRef(index, target.symbolId) : { file: target.file! },
    findings,
    markers: markersFor ? [...markersFor.values()].filter((entry) => matches(entry.symbol)) : [],
    summary: {
      findings: findings.length,
      asSource: asSource.length,
      asSink: asSink.length,
      onPath: onPath.length,
      note: findings.length === 0
        ? 'No path between untrusted input and a dangerous call reaches this, as far as the patterns can see. That is not the same as it being safe.'
        : `${findings.length} place(s) worth reading, none of them proof of a vulnerability.`,
    },
  };
}
