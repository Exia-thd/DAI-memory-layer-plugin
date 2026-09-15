import fs from 'node:fs';
import { TOKENIZER_VERSION } from './util/tokenize.js';
import path from 'node:path';
import type { MemoryStore } from './store/store.js';
import { pendingCount } from './store/journal.js';
import { summarizeCapability } from './store/capabilities.js';
import { identityLabel, type EmbeddingIdentity } from './embed/types.js';
import { embeddingReadiness } from './embed/model-cache.js';
import { unreplayableWalCopies } from './store/store.js';
import { probeAstChunking, relationLanguages } from './ingest/languages.js';
import { CHUNKER_VERSION } from './ingest/chunker.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  failed: boolean;
}

/**
 * The answer to "is this thing actually working".
 *
 * It exists because the failure mode that matters here is not a crash, it is a
 * store that looks fine and holds one node and no edges. Every check reports a
 * number rather than a reassurance.
 */
export async function doctor(
  store: MemoryStore,
  activeIdentity: EmbeddingIdentity | null,
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const meta = store.getMeta();

  let stats: Awaited<ReturnType<MemoryStore['stats']>> | null = null;
  try {
    stats = await store.stats();
    const bytes = directorySize(store.dir);
    checks.push({
      name: 'store',
      status: stats.nodes === 0 ? 'warn' : 'ok',
      detail:
        `${stats.nodes.toLocaleString()} nodes / ${stats.edges.toLocaleString()} edges / ` +
        `${(bytes / 1e6).toFixed(1)} MB` +
        (stats.nodes === 0 ? ' -- store is empty; run `dai-memory ingest`' : ''),
    });
  } catch (err) {
    checks.push({
      name: 'store',
      status: 'fail',
      detail: `Cannot read the store: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const [name, capability] of Object.entries(meta.capabilities ?? {})) {
    // Re-probed below against the live toolchain rather than read back.
    if (name === 'astChunking') continue;
    checks.push({
      name,
      status: capability.status === 'available' ? 'ok' : capability.status === 'degraded' ? 'warn' : 'fail',
      detail: summarizeCapability(capability),
    });
  }

  // AST chunking is re-probed rather than read back, because it depends on
  // installed packages that can change after init. A machine where it silently
  // stopped working looks identical to one where it never worked, and the
  // difference only shows up as quietly worse chunks.
  const ast = await probeAstChunking();
  const recorded = meta.capabilities?.astChunking;
  checks.push({
    name: 'astChunking',
    status: ast.status === 'available' ? 'ok' : ast.status === 'degraded' ? 'warn' : 'fail',
    detail:
      `${ast.provider} -- ${ast.reason}` +
      (recorded && recorded.status !== ast.status
        ? ` (recorded as ${recorded.status} at init; it has changed since)`
        : ''),
  });

  // A log set aside by a recovery is a write somebody made and did not keep.
  // Reported until the copy is removed, because the recovery itself printed
  // once, to whatever terminal happened to be running the command.
  const walCopies = unreplayableWalCopies(store.dir);
  checks.push({
    name: 'interrupted writes',
    status: walCopies.length === 0 ? 'ok' : 'warn',
    detail: walCopies.length === 0
      ? 'none'
      : `${walCopies.length} write-ahead log(s) could not be replayed and were set aside after an ` +
        `interrupted write: ${walCopies.join(', ')}. What they held was lost; redo the interrupted ` +
        'command, then delete the copies.',
  });

  // Whether this machine can embed at all, checked on disk rather than by
  // loading the model. It fails rather than warns: without the model, search,
  // write, ingest and the MCP server all refuse to run, so a store that is
  // otherwise healthy is not usable here.
  const readiness = embeddingReadiness();
  checks.push({
    name: 'embedding model',
    status: readiness.ready ? 'ok' : 'fail',
    detail: readiness.ready ? 'present' : readiness.problem ?? 'unavailable',
  });

  if (stats) {
    const missing = stats.nodes - stats.embedded;
    checks.push({
      name: 'vectors',
      status: stats.nodes === 0 ? 'ok' : missing > 0 ? 'warn' : 'ok',
      detail:
        `${stats.embedded.toLocaleString()}/${stats.nodes.toLocaleString()} embedded` +
        (activeIdentity ? ` - active space ${identityLabel(activeIdentity)}` : ' - no active provider'),
    });

    // Two vector spaces in one store is the failure that costs recall while
    // looking completely healthy, so it is checked explicitly.
    const spaces = await vectorSpaces(store);
    if (spaces.size > 1) {
      checks.push({
        name: 'model drift',
        status: 'warn',
        detail:
          `${spaces.size} vector spaces present (${[...spaces.entries()]
            .map(([space, n]) => `${space}: ${n}`)
            .join(', ')}). Re-embed so one space covers the store.`,
      });
    } else if (activeIdentity && spaces.size === 1) {
      const [[space]] = [...spaces.entries()] as [[string, number]];
      checks.push({
        name: 'model drift',
        status: space === identityLabel(activeIdentity) ? 'ok' : 'warn',
        detail:
          space === identityLabel(activeIdentity)
            ? 'stored vectors match the active provider'
            : `stored vectors are ${space}, active provider is ${identityLabel(activeIdentity)}`,
      });
    }

    // An index holding fewer documents than the store holds nodes is pure silent
    // recall loss: the keyword branch answers, just not about everything.
    const index = await store.indexStats();
    const behind = stats.nodes - index.docCount;
    checks.push({
      name: 'keyword index',
      status: index.docCount === 0 && stats.nodes > 0 ? 'fail' : behind > 0 ? 'warn' : 'ok',
      detail:
        index.docCount === 0 && stats.nodes > 0
          ? `no postings for ${stats.nodes} nodes -- keyword search falls back to an ` +
            'in-memory rebuild; run `dai-memory ingest --force`'
          : behind > 0
            ? `${index.docCount}/${stats.nodes} nodes indexed; ${behind} are invisible to keyword search`
            : `${index.docCount.toLocaleString()} nodes indexed`,
    });

    // Postings built by one tokenizer and queried by another match on the
    // overlap and miss the rest, silently. The version is the only way to see it.
    const builtWith = meta.tokenizerVersion;
    checks.push({
      name: 'tokenizer version',
      status:
        stats.nodes === 0 ? 'ok' : builtWith === TOKENIZER_VERSION ? 'ok' : 'fail',
      detail:
        stats.nodes === 0
          ? `v${TOKENIZER_VERSION}, no nodes indexed yet`
          : builtWith === TOKENIZER_VERSION
            ? `postings built with v${TOKENIZER_VERSION}`
            : `postings built with ${builtWith === undefined ? 'an unrecorded tokenizer' : `v${builtWith}`}, ` +
              `this build queries with v${TOKENIZER_VERSION} -- keyword results are ` +
              'partial until `dai-memory ingest --force` rebuilds them',
    });

    // Files read by an older reader keep that reader's chunks and symbols until
    // they are read again. Ingest does that on its own; this says how many wait.
    const stamps = Object.values(meta.fileHashes ?? {});
    const olderReader = stamps.filter((stamp) => !stamp.startsWith(`${CHUNKER_VERSION}:`)).length;
    checks.push({
      name: 'code reader',
      status: olderReader > 0 ? 'warn' : 'ok',
      detail:
        olderReader > 0
          ? `${olderReader}/${stamps.length} files were read by an older version of the code reader -- ` +
            'their chunks and code graph are out of date until `dai-memory ingest` re-reads them'
          : `v${CHUNKER_VERSION}, ${stamps.length} files`,
    });

    // The code graph, and what it could not resolve. A call whose name matched
    // nothing or matched five things is not an edge, and the count is the only
    // place that difference is visible.
    const calls = await store.allCalls();
    const pending = await store.countPendingCalls();
    const languages = relationLanguages();
    // A call into a framework is not a gap in the graph, and counting it as one
    // made a working graph read as 5% complete. What matters is the share of
    // calls into this repository's own code that found their declaration.
    const ambiguous = await store.countAmbiguousCalls();
    const internal = calls.length + ambiguous;
    const reach = internal === 0 ? 100 : Math.round((calls.length / internal) * 100);
    checks.push({
      name: 'code graph',
      status: !store.graphReady ? 'warn' : reach < 80 ? 'warn' : 'ok',
      detail: !store.graphReady
        ? 'this store predates the code graph; the next `dai-memory ingest` builds it'
        : `${calls.length} call(s), ${(await store.allInherits()).length} inherit(s), ` +
          `${(await store.allImports()).length} import(s); ${reach}% of calls into this repository resolved` +
          (ambiguous > 0 ? `, ${ambiguous} ambiguous` : '') +
          `; ${pending - ambiguous} call(s) go outside it` +
          (languages.without.length > 0
            ? ` -- no call extraction for ${languages.without.join(', ')}`
            : ''),
    });

    const orphans = await store.orphanedMemories();
    checks.push({
      name: 'orphans',
      status: orphans > 0 ? 'warn' : 'ok',
      detail:
        orphans > 0
          ? `${orphans} recorded memor${orphans === 1 ? 'y' : 'ies'} connect to nothing -- ` +
            'a decision with no link to what it constrains is hard to find later'
          : 'every recorded memory is connected',
    });

    // Whether the cited file is still there.
    //
    // `orphans` asks whether a memory is connected to the graph, which a memory
    // about a deleted file still is. So the store could hold chunks of files
    // that no longer exist, keep returning them, cite line ranges in nothing --
    // and report every check green. A store that is behind is usable; a store
    // that is behind and says it is fine is worse than none, because it is
    // believed.
    const root = store.getMeta().projectRoot;
    const tracked = await store.artifactFiles();
    const vanished = tracked.filter((file) => !fs.existsSync(path.join(root, file)));
    checks.push({
      name: 'file anchors',
      status: vanished.length > 0 ? 'warn' : 'ok',
      detail:
        vanished.length > 0
          ? `${vanished.length} file(s) in the index no longer exist on disk ` +
            `(${vanished.slice(0, 3).join(', ')}${vanished.length > 3 ? ', ...' : ''}) -- ` +
            'their memories still answer queries; run `dai-memory ingest` to reclaim them'
          : `${tracked.length} indexed file(s) all present on disk`,
    });
  }

  const pending = pendingCount(store.dir);
  checks.push({
    name: 'journal',
    status: pending > 0 ? 'warn' : 'ok',
    detail:
      pending > 0
        ? `${pending} writes queued and not yet searchable -- run \`dai-memory merge\``
        : 'no queued writes',
  });

  return { checks, failed: checks.some((check) => check.status === 'fail') };
}

async function vectorSpaces(store: MemoryStore): Promise<Map<string, number>> {
  const rows = await store.query(
    `MATCH (m:Memory) WHERE m.embedding_model <> ''
     RETURN m.embedding_model AS model, m.embedding_dims AS dims,
            m.embedding_provider AS provider, count(*) AS n`,
  );
  const spaces = new Map<string, number>();
  for (const row of rows) {
    spaces.set(`${row.model}@${row.dims}/${row.provider}`, Number(row.n));
  }
  return spaces;
}

async function orphanCount(store: MemoryStore): Promise<number> {
  const nodes = await store.allNodes();
  const connected = new Set<string>();
  for (const edge of await store.allEdges()) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return nodes.filter((node) => !connected.has(node.id)).length;
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

export function formatReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.name.length)) + 2;
  return report.checks
    .map((check) => {
      const status = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
      return `${check.name.padEnd(width)}${status}    ${check.detail}`;
    })
    .join('\n');
}
