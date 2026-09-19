#!/usr/bin/env node
import {
  formatReport, forgetProject, LAYERS, EDGE_TYPES,
  type Layer, type EdgeType, type IgnoredFile,
} from '@memory-layer/core';
import * as api from './api.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { resolveProject, storeDirOrThrow } from './project.js';
// Imported where it is used, not at the top.
//
// `mcp.js` drags in the MCP SDK, which cost 290ms on every command that is not
// `serve` -- `memory --help` included. One command needs it; the rest were
// paying for it.

/**
 * Every command returns a process exit code, and a failure exits non-zero with
 * the reason on stderr. A command that fails quietly is worse than one that
 * crashes, because the caller carries on believing the work happened.
 */

/**
 * With no paths named, the whole repository -- not a guess about which parts
 * of it matter.
 *
 * The scan used to pick directories: conventional names, plus any directory
 * that looked like a project. That was a guess, and a guess about a tree is
 * wrong about exactly the trees that are organised: markdown in `notes/` or
 * `wiki/` or `design/` -- sometimes the repository's own hand-kept memory --
 * matched neither rule and was silently left out.
 *
 * Guessing was only ever there to keep vendored code and build output out of
 * the store, and the walk now does that itself, by rule: dependency and build
 * directories, secrets and lockfiles, binaries, `.memignore`, each skip
 * reported with its reason. With those in place the root is the right target
 * and the guess has nothing left to protect.
 */
function announceScan(quiet: boolean): string[] {
  if (!quiet) {
    process.stdout.write(
      'scanning the whole repository (dependencies, build output, secrets and binaries are skipped)\n',
    );
  }
  return ['.'];
}

/**
 * The paths this run will read, announced either way.
 *
 * Named paths are announced too. They are the user's own words, but the line is
 * what makes a typo visible in the second before the scan rather than in an
 * empty result an hour later -- and a command whose output changes shape
 * depending on how it was invoked is harder to read than one that does not.
 * Quiet under --json, where anything on stdout is no longer JSON.
 */
function chooseScan(args: Args): string[] {
  const quiet = Boolean(args.flags.json) || Boolean(args.flags.quiet);
  if (args.positional.length > 0) {
    if (!quiet) process.stdout.write(`scanning ${args.positional.join(', ')}\n`);
    return args.positional;
  }
  return announceScan(quiet);
}

/**
 * What the walk passed over, grouped by reason.
 *
 * Ingest reported only what it took. Nine files out of twenty-one could be left
 * behind -- diagrams kept as source, a directory named `build` -- under a line
 * that read like success. Skipping is a fine decision; skipping quietly is how
 * a store ends up trusted and incomplete at the same time.
 */
function formatIgnored(ignored: IgnoredFile[], verbose: boolean): string {
  if (ignored.length === 0) return '';

  const byReason = new Map<string, IgnoredFile[]>();
  for (const entry of ignored) {
    const list = byReason.get(entry.reason) ?? [];
    list.push(entry);
    byReason.set(entry.reason, list);
  }

  const lines = [`\nskipped ${ignored.length}:`];
  for (const [reason, entries] of byReason) {
    const details = [...new Set(entries.map((entry) => entry.detail))].sort();
    const shown = details.slice(0, 8).join(' ');
    const more = details.length > 8 ? ` +${details.length - 8} more` : '';
    lines.push(`   ${entries.length} ${reason} (${shown}${more})`);
    // A skip the reader cannot undo is only half a message. Every reason that
    // has a way out says what it is; the one that does not says why not.
    const wayOut: Record<string, string> = {
      'not indexed unless named': 'name the file to index it anyway',
      'too large': 'name the file to index it anyway, or --max-file-size <MB>',
      'excluded directory': 'name the directory to index it anyway',
      'secret or machine bookkeeping': 'deliberate: credentials must never reach an embedding',
      'not text': 'nothing to index; read it with an agent and record the conclusion',
      '.memignore': 'your own rule; name the path to index it anyway',
    };
    const hint = wayOut[reason];
    if (hint) lines.push(`      ${hint}`);
    if (verbose) for (const entry of entries) lines.push(`      ${entry.path}`);
  }
  if (!verbose) lines.push('   --verbose to list them');
  return lines.join('\n');
}

/**
 * What init did, said so that a rebuild cannot be mistaken for a new store and a
 * wipe cannot be mistaken for either.
 *
 * Links that did not survive a rebuild are listed by id. Each was somebody's
 * judgement; a count alone would tell the reader something was lost without
 * telling them what to look at.
 */
function describeInit(storeDir: string, outcome: api.InitOutcome): string {
  const lines: string[] = [];
  if (outcome.wiped) lines.push(`removed the previous store, recorded memories included (--fresh)`);

  if (outcome.mode === 'created') {
    lines.push(`store created at ${storeDir}`);
  } else if (outcome.mode === 'refreshed') {
    lines.push(
      `store at ${storeDir} brought up to date; nothing rebuilt (--no-scan). ` +
        'Run init without --no-scan to rebuild what a scan produces.',
    );
  } else if (outcome.rebuild) {
    const r = outcome.rebuild;
    lines.push(
      `store at ${storeDir} rebuilt: ${r.cleared} scanned chunks cleared and read again.`,
      `kept ${r.kept} recorded memories, with the links between them untouched; restored ` +
        `${r.linksRestored} link(s) to scanned chunks and ${r.anchorsRestored} code anchor(s).`,
    );
    const dropped = r.droppedLinks.length + r.droppedAnchors.length;
    if (dropped > 0) {
      lines.push(`${dropped} recorded link(s) could not be restored -- what they pointed at no longer exists:`);
      for (const link of r.droppedLinks.slice(0, 20)) lines.push(`   ${link.from} -${link.type}-> ${link.to}`);
      for (const anchor of r.droppedAnchors.slice(0, 20)) lines.push(`   ${anchor.memoryId} ABOUT ${anchor.symbolId}`);
      if (dropped > 40) lines.push(`   ... and more; --json lists them all`);
    }
  }
  return lines.join('\n');
}

const USAGE = `dai-memory - project memory layer

  dai-memory init [paths...] [--no-scan] [--fresh] [--json]
                          create the store, scan the project, build the viewer.
                          Run again to rebuild what a scan produces; recorded
                          memories are kept. --fresh removes them as well.
  dai-memory ingest [paths...] [--layer L] [--force] [--no-ui]
                          [--verbose] [--quiet] [--max-file-size MB]  no paths: scan the project
  dai-memory embed [--force]              embed nodes missing a current vector
  dai-memory index <query> [--limit N] [--offset N] [--layer L] [--json]
                          titles only, ~15 tokens each -- pick before you read
  dai-memory search <query> [--limit N] [--offset N] [--layer L] [--json]
                          [--disable bm25,semantic,entity,graph]  measure a branch by removing it
  dai-memory why <file|symbol> [--limit N] [--offset N] [--json]   decisions touching it
  dai-memory get <id> [--json]            one node plus its direct edges
  dai-memory graph <id> [--depth N] [--edge TYPE] [--json]
  dai-memory constraints [--limit N]      decisions in force, most important first
  dai-memory changes [--scope S] [--base R]  what memory records about your changed files
  dai-memory map [path] [--format tree|mermaid]  the code graph: files, declarations, memory
  dai-memory impact <symbol> [--direction upstream|downstream] [--depth 1-5] [--min-confidence 0-1]
                          [--file F] [--uid ID] [--include-tests] [--json]
                          what breaks if it changes, by distance, with a risk level
  dai-memory context <symbol> [--file F] [--uid ID] [--json]
                          callers, callees, types, members, imports and memory for one declaration
  dai-memory trace <from> <to> [--depth N] [--from-file F] [--to-file F] [--include-tests] [--json]
  dai-memory query <words...> [--limit N] [--include-tests] [--json]
      What answers to these words, grouped by the execution flow it runs in.
  dai-memory processes [--limit N] [--include-tests] [--json]
      Every execution flow: an entry point and what it reaches.
  dai-memory process <name> [--include-tests] [--json]
      One flow, step by step.
  dai-memory detect-changes [--scope staged|working|compare] [--base REF] [--depth 1-3] [--json]
      What a diff changes in declarations: dependents, flows and risk.
  dai-memory review [--base REF] [--depth 1-3] [--json]
      A branch as a reviewer wants it: what can break, where, and who has worked there.
  dai-memory rename <symbol> <new name> [--file F] [--uid ID] [--apply] [--include-text] [--json]
      Rename through the call graph. Shows the plan; --apply writes it.
  dai-memory check [--fail-on error|warning] [--include-tests] [--json]
      Invariants over the code graph, with what each rule examined.
  dai-memory code-clusters [--min-size N] [--limit N] [--json]
      Communities in the call graph: the parts that talk to each other.
  dai-memory cypher <query> [--limit N] [--json]
      One read-only query against the store. Writing clauses are refused.
  dai-memory status [--json]
      What is indexed, from which commit, and whether that is still current.
  dai-memory clean --yes
      Remove this project's store. Nothing is removed without --yes.
                          the shortest call path between two declarations
  dai-memory prune [--older-than 90] [--dry-run]  forget old, unreferenced episodic memories
  dai-memory ui [path] [--out FILE] [--max-nodes N]
                                          build a browser view of the graph and the store
  dai-memory session start <label> | end [--summary S] | (none)   open, close or show the session
  dai-memory summarize <clusterId> --body S   record a summary for a group of memories
  dai-memory conflicts [--json]           contradictions needing a person
  dai-memory clusters [--json]            communities in the memory graph
  dai-memory write --layer L --title T --body B --source-ref R [--link ID:TYPE] [--importance 0-10]
  dai-memory link <from> <to> <TYPE> [--weight W]
  dai-memory merge                        fold queued session writes into the store
  dai-memory eval [--top N] [--json]      score retrieval against .memory-eval.json
  dai-memory doctor [--json]              what is actually working
  dai-memory list                         registered projects
  dai-memory forget [path]                drop a project from the registry
  dai-memory serve                        MCP server on stdio

layers: ${LAYERS.join(', ')}
edges:  ${EDGE_TYPES.join(', ')}`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

/**
 * Writes the viewer, so it is there and current without anybody remembering it.
 *
 * The page carries its data inline because a browser refuses `fetch` over
 * `file://`. That makes a stale page the normal state rather than an accident,
 * and the only fix is to rewrite it whenever the store changed -- which is why
 * this runs after ingest rather than waiting to be asked.
 *
 * `--no-ui` skips it for a command that does not want the cost.
 */
async function refreshUi(): Promise<string | null> {
  let storeDir: string;
  try {
    storeDir = storeDirOrThrow();
  } catch {
    return null;
  }

  const page = nodePath.join(storeDir, 'ui.html');

  try {
    const { runUi } = await import('./ui.js');
    const built = await runUi({ out: page });
    return built.file;
  } catch (err) {
    // A viewer that failed to rebuild must not fail the command that triggered
    // it -- but it must not pretend to have rebuilt either, or the page quietly
    // goes on showing last week.
    process.stderr.write(
      `warning: could not refresh ${page}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/**
 * The size limit for this run, if the user set one.
 *
 * A default that cannot be overruled is not a default, it is a rule -- and this
 * one has to bend, because the person who put a large export in the tree is the
 * only one who knows whether it is worth indexing.
 */
function maxFileBytes(args: Args): number | undefined {
  const flag = stringFlag(args, 'max-file-size') ?? process.env.MEMORY_LAYER_MAX_FILE_MB;
  if (flag === undefined) return undefined;

  const mb = Number(flag);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new Error(`--max-file-size expects megabytes, got ${JSON.stringify(flag)}`);
  }
  return Math.round(mb * 1_000_000);
}

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(args: Args, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got ${JSON.stringify(value)}`);
  return parsed;
}

function layerFlag(args: Args, name = 'layer'): Layer | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  if (!LAYERS.includes(value as Layer)) {
    throw new Error(`Unknown layer ${JSON.stringify(value)}. Known: ${LAYERS.join(', ')}`);
  }
  return value as Layer;
}

function edgeType(value: string): EdgeType {
  if (!EDGE_TYPES.includes(value as EdgeType)) {
    throw new Error(`Unknown edge type ${JSON.stringify(value)}. Known: ${EDGE_TYPES.join(', ')}`);
  }
  return value as EdgeType;
}

function emit(args: Args, data: unknown, text: () => string): void {
  if (args.flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${text()}\n`);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || command === 'help' || command === '--help' || args.flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  switch (command) {
    case 'init': {
      const targets = args.flags['no-scan'] ? [] : chooseScan(args);


      const { storeDir, report, scanned, page, outcome } = await api.init({
        dimensions: stringFlag(args, 'dims'),
        scan: targets,
        ui: !args.flags['no-ui'],
        fresh: Boolean(args.flags.fresh),
      });
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify({ storeDir, outcome, report, scanned, page }, null, 2)}\n`);
        return report.failed ? 1 : 0;
      }
      process.stdout.write(`${describeInit(storeDir, outcome)}\n\n${formatReport(report)}\n`);
      if (report.failed) {
        process.stderr.write('\ninit finished with failing checks; fix them before relying on search.\n');
        return 1;
      }

      // Installing into a codebase that already exists is what this is for, so
      // init finishes the job: scan, build the code graph, write the viewer.
      // Anything else leaves a new user with an empty store and a second command
      // to discover.
      if (scanned) {
        process.stdout.write(
          `
${scanned.created} memories, ${scanned.symbols} declarations from ${scanned.files} files\n`,
        );
        if (page) process.stdout.write(`open ${page}\n`);
      }
      return 0;
    }

    case 'ingest': {
      // No paths is the common case, not an error: the daily command is
      // `dai-memory ingest`, and with nothing named it reads the whole tree.
      const paths = chooseScan(args);
      const report = await api.runIngest(paths, {
        layer: layerFlag(args),
        force: Boolean(args.flags.force),
        maxFileBytes: maxFileBytes(args),
      });
      if (!args.flags.quiet) emit(args, report, () =>
        `ingested ${report.files} files (${report.skipped} unchanged) -> ` +
        `${report.created} new, ${report.refreshed} refreshed, ${report.embedded} embedded` +
        // What the files stopped producing. Counted all along and never printed,
        // so replacing 4,729 stale chunks read exactly like adding nothing.
        (report.removed > 0 ? `, ${report.removed} removed` : '') +
        (report.superseded > 0 ? `, ${report.superseded} superseded` : '') +
        (report.symbols > 0
          ? `\ncode graph: ${report.symbols} declaration(s), ${report.relations.calls} call(s), ` +
            `${report.relations.inherits} inherit(s), ${report.relations.imports} import(s)` +
            (report.relations.ambiguous > 0
              ? `, ${report.relations.ambiguous} call(s) too ambiguous to place`
              : '') +
            (report.relations.external > 0
              ? `, ${report.relations.external} call(s) into code outside the repository`
              : '') +
            (report.relations.failed > 0
              ? `
   ${report.relations.failed} file(s) whose relations could not be written`
              : '')
          : '') +
        (report.vanished > 0 ? `
reclaimed ${report.vanished} file(s) no longer on disk` : '') +
        (report.symbolsRemoved > 0
          ? `\ndropped ${report.symbolsRemoved} declaration(s) the code no longer makes`
          : '') +
        (report.dense.length > 0
          ? '\n' + report.dense
              .map((d) => `   ${d.path}: ${d.chunks} chunks from ${d.kb} KB -- unusually dense`)
              .join('\n')
          : '') +
        // Offered, not recorded. Which of these is a decision worth keeping is
        // the judgement this layer exists to capture, and a chunk promoted
        // automatically would be a decision nobody made.
        (report.candidates.length > 0
          ? `\n\n${report.candidates.length} chunk(s) read like recorded reasoning:\n` +
            report.candidates
              .slice(0, 8)
              .map((c) => `   ${c.sourceRef}\n      "${c.excerpt}"`)
              .join('\n') +
            (report.candidates.length > 8
              ? `\n   ... and ${report.candidates.length - 8} more`
              : '') +
            '\n   worth a decision? dai-memory write --layer semantic --source-ref <ref> ...'
          : '') +
        formatIgnored(report.ignored, Boolean(args.flags.verbose)) +
        (report.redactions.length > 0
          ? `\nredacted: ${report.redactions.map((r) => `${r.rule} x${r.count}`).join(', ')}`
          : ''),
      );
      if (report.created + report.refreshed + report.removed > 0 && !args.flags['no-ui']) {
        const page = await refreshUi();
        if (page && !args.flags.json && !args.flags.quiet) process.stdout.write(`refreshed ${page}\n`);
      }
      return 0;
    }

    case 'embed': {
      const result = await api.runEmbed({ force: Boolean(args.flags.force) });
      emit(args, result, () => `embedded ${result.embedded}, already current ${result.skipped}`);
      return 0;
    }

    case 'search': {
      const query = args.positional.join(' ');
      if (!query) throw new Error('search needs a query');
      const result = await api.runSearch(query, {
        limit: numberFlag(args, 'limit'),
        offset: numberFlag(args, 'offset'),
        layers: layerFlag(args) ? [layerFlag(args)!] : undefined,
        disableBm25: Boolean(args.flags['no-bm25']),
        // `--disable semantic,graph` -- the flag that turns "is this branch
        // worth its cost" from an opinion into a measurement.
        disable: stringFlag(args, 'disable')?.split(',').map((name) => name.trim()),
      });
      emit(args, result, () => formatSearch(result));
      return 0;
    }

    case 'index': {
      const query = args.positional.join(' ');
      if (!query) throw new Error('index needs a query');
      const result = await api.runIndex(query, {
        limit: numberFlag(args, 'limit'),
        offset: numberFlag(args, 'offset'),
        layers: layerFlag(args) ? [layerFlag(args)!] : undefined,
      });
      emit(args, result, () => {
        if (result.results.length === 0) return 'no results';
        const lines = result.results.map(
          (entry, i) =>
            `${String(result.offset + i + 1).padStart(3)}. [${entry.layer}] ${entry.title}` +
            `${entry.stale ? '  (stale)' : ''}
     ${entry.sourceRef}`,
        );
        if (result.omitted > 0) {
          lines.push(
            `${result.omitted} more of ${result.total} -- --offset ${result.offset + result.results.length}`,
          );
        }
        return lines.join('\n');
      });
      return 0;
    }

    case 'why': {
      const target = args.positional[0];
      if (!target) throw new Error('why needs a file path or symbol');
      const result = await api.runWhy(target, {
        limit: numberFlag(args, 'limit'),
        offset: numberFlag(args, 'offset'),
        anchorOnly: Boolean(args.flags['anchor-only']),
      });
      emit(args, result, () => formatSearch(result));
      return 0;
    }

    case 'get': {
      const id = args.positional[0];
      if (!id) throw new Error('get needs a node id');
      const found = await api.runGet(id);
      if (!found) {
        process.stderr.write(`no such node: ${id}\n`);
        return 1;
      }
      emit(args, found, () =>
        `${found.node.title}\n${found.node.layer} - ${found.node.sourceRef}\n\n${found.node.body}\n\n` +
        `edges (${found.edges.length}):\n` +
        found.edges.map((e) => `  ${e.from} -[${e.type}]-> ${e.to}`).join('\n'),
      );
      return 0;
    }

    case 'graph': {
      const id = args.positional[0];
      if (!id) throw new Error('graph needs a node id');
      const edge = stringFlag(args, 'edge');
      const subgraph = await api.runNeighbors(id, {
        depth: numberFlag(args, 'depth'),
        edgeTypes: edge ? [edgeType(edge)] : undefined,
      });
      emit(args, subgraph, () =>
        `${subgraph.root.title}  (depth ${subgraph.depth}, ${subgraph.neighbors.length} neighbours)\n` +
        subgraph.neighbors
          .map((n) => `  ${'  '.repeat(n.hops - 1)}[${n.hops}] ${n.node.title}  <${n.via.map((v) => v.type).join(',')}>`)
          .join('\n'),
      );
      return 0;
    }

    case 'constraints': {
      const found = await api.runConstraints({ limit: numberFlag(args, 'limit') });
      emit(args, found, () =>
        found.length === 0
          ? 'no constraints recorded'
          : found.map((n) => `[${n.importance}] ${n.title}\n    ${n.sourceRef}`).join('\n'),
      );
      return 0;
    }

    case 'session': {
      const [action, ...rest] = args.positional;
      if (action === 'start') {
        const label = rest.join(' ') || 'untitled';
        const started = await api.runSessionStart(label);
        emit(args, started, () => `session ${started.label} open (${started.id})`);
        return 0;
      }
      if (action === 'end') {
        const closed = await api.runSessionEnd({ summary: stringFlag(args, 'summary') });
        emit(args, closed, () => (closed.closed ? `session closed (${closed.closed})` : 'no session open'));
        return 0;
      }
      const open = api.currentSession(storeDirOrThrow());
      emit(args, { open }, () => (open ? `${open.label} (${open.id})` : 'no session open'));
      return 0;
    }

    case 'map': {
      const { runMap, formatMapTree, formatMapMermaid } = await import('./map.js');
      const map = await runMap({ prefix: args.positional[0] });
      const format = stringFlag(args, 'format') ?? 'tree';
      emit(args, map, () =>
        format === 'mermaid' ? formatMapMermaid(map) : formatMapTree(map),
      );
      return 0;
    }

    case 'impact':
    case 'context':
    case 'trace': {
      const code = await import('./code.js');
      const target = (name: string | undefined, fileFlag: string, uidFlag?: string) => ({
        name, file: stringFlag(args, fileFlag), uid: uidFlag ? stringFlag(args, uidFlag) : undefined,
      });

      // Every one of the three answers with a status; the formatters take the
      // shape that status implies.
      let result: { status: string };
      if (command === 'impact') {
        const raw = (stringFlag(args, 'direction') ?? 'upstream').toLowerCase();
        const direction = raw === 'up' || raw === 'upstream' ? 'upstream'
          : raw === 'down' || raw === 'downstream' ? 'downstream' : null;
        if (!direction) throw new Error(`--direction is upstream or downstream, got ${JSON.stringify(raw)}`);
        if (!args.positional[0] && !stringFlag(args, 'uid')) throw new Error('impact needs a symbol name or --uid');
        result = await code.runImpact(target(args.positional[0], 'file', 'uid'), {
          direction,
          maxDepth: numberFlag(args, 'depth'),
          minConfidence: numberFlag(args, 'min-confidence'),
          includeTests: Boolean(args.flags['include-tests']),
          flows: !args.flags['no-flows'],
        });
        if (result.status === 'ok') {
          emit(args, result, () => code.formatImpact(result as never));
          return 0;
        }
      } else if (command === 'context') {
        if (!args.positional[0] && !stringFlag(args, 'uid')) throw new Error('context needs a symbol name or --uid');
        result = await code.runContext(target(args.positional[0], 'file', 'uid'), {
          flows: !args.flags['no-flows'],
        });
        if (result.status === 'ok') {
          emit(args, result, () => code.formatContext(result as never));
          return 0;
        }
      } else {
        if (args.positional.length < 2) throw new Error('trace needs <from> and <to>');
        result = await code.runTrace(
          target(args.positional[0], 'from-file'),
          target(args.positional[1], 'to-file'),
          { maxDepth: numberFlag(args, 'depth'), includeTests: Boolean(args.flags['include-tests']) },
        );
        if (result.status === 'ok' || result.status === 'no_path') {
          emit(args, result, () => code.formatTrace(result as never));
          // No path is an answer, not a failure: it says where the chain breaks.
          return 0;
        }
      }
      // A name that fits nothing, or several things, is not an answer to the
      // question asked. Exiting non-zero lets a script tell it from one.
      emit(args, result, () => code.formatUnresolved(result as never));
      return 1;
    }

    case 'processes': {
      const code = await import('./code.js');
      const list = await code.runProcesses({
        limit: numberFlag(args, 'limit'),
        includeTests: Boolean(args.flags['include-tests']),
      });
      emit(args, list, () => code.formatProcesses(list));
      return 0;
    }

    case 'process': {
      if (!args.positional[0]) throw new Error('process needs the name of an execution flow');
      const code = await import('./code.js');
      const flow = await code.runProcess(args.positional[0], {
        includeTests: Boolean(args.flags['include-tests']),
      });
      if (flow.status === 'ok') {
        emit(args, flow, () => code.formatProcess(flow as never));
        return 0;
      }
      emit(args, flow, () => code.formatProcessUnresolved(flow as never));
      return 1;
    }

    case 'query': {
      if (!args.positional[0]) throw new Error('query needs something to look for');
      const code = await import('./code.js');
      const found = await code.runQuery(args.positional.join(' '), {
        limit: numberFlag(args, 'limit'),
        includeTests: Boolean(args.flags['include-tests']),
      });
      emit(args, found, () => code.formatQuery(found));
      return 0;
    }

    case 'check': {
      const code = await import('./code.js');
      const result = await code.runCheck({
        includeTests: Boolean(args.flags['include-tests']),
        examples: numberFlag(args, 'examples'),
      });
      emit(args, result, () => code.formatCheck(result));
      // Findings are information, not failure: a warning about an import cycle
      // must not stop a commit unless somebody asked it to.
      const failOn = stringFlag(args, 'fail-on');
      if (failOn === 'warning') return result.summary.errors + result.summary.warnings > 0 ? 1 : 0;
      if (failOn === 'error') return result.summary.errors > 0 ? 1 : 0;
      return 0;
    }

    case 'code-clusters': {
      const code = await import('./code.js');
      const result = await code.runCodeClusters({
        minSize: numberFlag(args, 'min-size'),
        limit: numberFlag(args, 'limit'),
        includeTests: Boolean(args.flags['include-tests']),
      });
      emit(args, result, () => code.formatCodeClusters(result));
      return 0;
    }

    case 'cypher': {
      if (!args.positional[0]) throw new Error('cypher needs a query');
      const code = await import('./code.js');
      const result = await code.runCypher(args.positional.join(' '), { limit: numberFlag(args, 'limit') });
      emit(args, result, () => code.formatCypher(result));
      return result.status === 'ok' ? 0 : 1;
    }

    case 'status': {
      const code = await import('./code.js');
      const result = await code.runStatus();
      emit(args, result, () => code.formatStatus(result));
      return 0;
    }

    case 'clean': {
      const { cleanStore } = await import('./clean.js');
      const result = cleanStore({ confirmed: Boolean(args.flags.yes) });
      emit(args, result, () => result.status === 'removed'
        ? [`removed ${result.dir}`, 'the project is no longer indexed; `dai-memory init` builds it again'].join('\n')
        : [result.dir, result.reason].join('\n'));
      return result.status === 'removed' ? 0 : 1;
    }

    case 'rename': {
      if (args.positional.length < 2 && !(stringFlag(args, 'uid') && args.positional[0])) {
        throw new Error('rename needs <symbol> <new name> (or --uid ID <new name>)');
      }
      const code = await import('./code.js');
      const [first, second] = args.positional;
      const uid = stringFlag(args, 'uid');
      const to = (uid ? first : second)!;
      const result = await code.runRename(
        { name: uid ? undefined : first, uid, file: stringFlag(args, 'file') },
        to,
        {
          apply: Boolean(args.flags.apply),
          includeTests: Boolean(args.flags['include-tests']),
          includeText: Boolean(args.flags['include-text']),
        },
      );
      emit(args, result, () => code.formatRename(result));
      // A refusal is not a rename. Only a plan or an applied rename exits zero.
      return result.status === 'ok' ? 0 : 1;
    }

    case 'detect-changes': {
      const code = await import('./code.js');
      const scope = (stringFlag(args, 'scope') ?? 'staged') as 'staged' | 'working' | 'compare';
      const result = await code.runDetectChanges({
        scope,
        baseRef: stringFlag(args, 'base'),
        maxDepth: numberFlag(args, 'depth'),
        includeTests: Boolean(args.flags['include-tests']),
        flows: !args.flags['no-flows'],
      });
      emit(args, result, () => code.formatDetectChanges(result));
      return 0;
    }

    case 'review': {
      const code = await import('./code.js');
      const result = await code.runReview({
        baseRef: stringFlag(args, 'base'),
        maxDepth: numberFlag(args, 'depth'),
        includeTests: Boolean(args.flags['include-tests']),
        flows: !args.flags['no-flows'],
      });
      emit(args, result, () => code.formatReview(result));
      return 0;
    }

    case 'changes': {
      const scope = (stringFlag(args, 'scope') ?? 'staged') as 'staged' | 'working' | 'compare';
      const report = await api.runChanges({ scope, baseRef: stringFlag(args, 'base') });
      emit(args, report, () => {
        if (report.changed.length === 0) return `no ${report.scope} changes`;
        const lines: string[] = [];
        for (const entry of report.covered) {
          lines.push(entry.file);
          for (const memory of entry.memories) {
            const mark = memory.contested ? ' [CONTESTED]' : '';
            lines.push(`    [${memory.layer}] ${memory.title}${mark}`);
            lines.push(`        ${memory.sourceRef}`);
          }
          if (entry.omitted > 0) {
            lines.push(`    ... and ${entry.omitted} more, not shown`);
          }
          // Recorded about code that calls in here, not about this file. Marked
          // as such: it is a weaker claim than a decision about the file itself.
          for (const memory of entry.viaCalls ?? []) {
            lines.push(`    [${memory.layer}] ${memory.title}`);
            lines.push(`        via a call into ${memory.reaches} -- ${memory.sourceRef}`);
          }
        }
        if (report.uncovered.length > 0) {
          lines.push(`${report.uncovered.length} changed file(s) with nothing recorded:`);
          for (const file of report.uncovered) lines.push(`    ${file}`);
        }
        if (report.contested > 0) {
          lines.push(`${report.contested} of these memories are contested -- settle them before committing.`);
        }
        return lines.join('\n');
      });
      return 0;
    }

    case 'conflicts': {
      const found = await api.runConflicts();
      emit(args, found, () =>
        found.length === 0
          ? 'no conflicts'
          : found
              .map(
                (c) =>
                  `${c.kind}: ${c.a.title}\n          vs ${c.b.title}\n` +
                  // The detection already happened; recording it is one command
                  // away and used to be several. An unrecorded contradiction is
                  // found again from scratch every time somebody asks.
                  `          dai-memory link ${c.a.id} ${c.b.id} CONTRADICTS`,
              )
              .join('\n\n'),
      );
      return 0;
    }

    case 'clusters': {
      const found = await api.runClusters();
      emit(args, found, () =>
        found.length === 0
          ? 'no clusters (the graph has too few edges)'
          : found
              .map((c) => `#${c.id} (${c.size}) ${c.terms.join(' ')}\n${c.representatives.map((r) => `    ${r.title}`).join('\n')}`)
              .join('\n'),
      );
      return 0;
    }

    case 'summarize': {
      const [rawId] = args.positional;
      const body = stringFlag(args, 'body');
      if (!rawId || !body) throw new Error('summarize needs <clusterId> and --body');
      const result = await api.runSummarize(Number(rawId), body, { title: stringFlag(args, 'title') });
      emit(args, result, () => `summary ${result.id} covers ${result.covers} memories`);
      return 0;
    }

    case 'write': {
      const layer = layerFlag(args);
      const title = stringFlag(args, 'title');
      const body = stringFlag(args, 'body');
      const sourceRef = stringFlag(args, 'source-ref');
      if (!layer || !title || !body || !sourceRef) {
        throw new Error('write needs --layer, --title, --body and --source-ref');
      }
      const links = (Array.isArray(args.flags.link) ? args.flags.link : [args.flags.link])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => {
          const [to, type] = value.split(':');
          if (!to || !type) throw new Error(`--link expects ID:TYPE, got ${JSON.stringify(value)}`);
          return { to, type: edgeType(type) };
        });

      // Range-checked here rather than clamped: a caller asking for 50 has a
      // different scale in mind, and quietly storing 10 would hide that.
      const importance = numberFlag(args, 'importance');
      if (importance !== undefined && (importance < 0 || importance > 10)) {
        throw new Error(`--importance is 0-10, got ${importance}`);
      }

      const result = await api.runWrite({ layer, title, body, sourceRef, links, importance });
      emit(args, result, () =>
        `${result.id}${result.queued ? ' (queued: the store was locked, run `dai-memory merge`)' : ''}` +
        (result.about.length > 0 ? `\nanchored to ${result.about.join(', ')}` : '') +
        // Printed as commands rather than as advice. A suggestion that takes
        // three steps to act on is one nobody acts on, and an unlinked graph is
        // a retrieval branch that never fires.
        (result.related.length > 0
          ? '\n\nrelated memories -- link them if they bear on each other:\n' +
            result.related
              .map((r) => `  dai-memory link ${result.id} ${r.id} DERIVED_FROM   # ${r.title}`)
              .join('\n')
          : '') +
        (result.redactions.length > 0
          ? `\nredacted: ${result.redactions.map((r) => `${r.rule} x${r.count}`).join(', ')}`
          : ''),
      );
      return 0;
    }

    case 'link': {
      const [from, to, type] = args.positional;
      if (!from || !to || !type) throw new Error('link needs <from> <to> <TYPE>');
      const result = await api.runLink(from, to, edgeType(type), { weight: numberFlag(args, 'weight') });
      emit(args, result, () => (result.queued ? 'queued (store locked)' : 'linked'));
      return 0;
    }

    case 'merge': {
      const result = await api.runMerge();
      emit(args, result, () =>
        result.skipped
          ? `not merged: ${result.skipped}`
          : `merged ${result.merged} entries from ${result.files} session journals`,
      );
      return result.skipped ? 1 : 0;
    }

    case 'prune': {
      const report = await api.runPrune({
        olderThanDays: numberFlag(args, 'older-than'),
        layer: stringFlag(args, 'layer'),
        dryRun: Boolean(args.flags['dry-run']),
      });
      emit(args, report, () => {
        if (report.candidates.length === 0) {
          return `nothing to prune (${report.layer} older than ${report.olderThanDays} days, with no edges)`;
        }
        const lines = report.candidates.map(
          (item) => `  ${item.ageDays}d  ${item.title}`,
        );
        lines.push(
          report.dryRun
            ? `${report.candidates.length} would be removed; re-run without --dry-run`
            : `removed ${report.removed}`,
        );
        return lines.join('\n');
      });
      if (report.removed > 0 && !args.flags['no-ui']) {
        const page = await refreshUi();
        if (page && !args.flags.json && !args.flags.quiet) process.stdout.write(`refreshed ${page}\n`);
      }
      return 0;
    }

    case 'ui': {
      const { runUi } = await import('./ui.js');
      const maxNodes = numberFlag(args, 'max-nodes');
      if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
        throw new Error(`--max-nodes expects a whole number of nodes, got ${maxNodes}`);
      }
      const built = await runUi({ prefix: args.positional[0], out: stringFlag(args, 'out'), maxNodes });
      emit(args, built, () =>
        `${built.file}\n${built.nodes} nodes${built.truncated ? ' (trimmed -- narrow it with a path)' : ''}` +
        '\nA snapshot: re-run after changing the store. Open it in a browser.',
      );
      return 0;
    }

    case 'eval': {
      const report = await api.runEval({ topK: numberFlag(args, 'top') });
      emit(args, report, () => {
        const lines = [`${report.questions} questions, recall@${report.topK}`, ''];
        for (const row of report.rows) {
          const pct = ((row.found / row.asked) * 100).toFixed(0);
          const width = ((row.high - row.low) * 100).toFixed(0);
          lines.push(
            `  ${row.label.padEnd(18)} ${String(row.found).padStart(3)}/${row.asked} (${pct}%)` +
            `  95% CI ${(row.low * 100).toFixed(0)}-${(row.high * 100).toFixed(0)}%, ${width} wide` +
            `   false ${row.rejected}/${row.asked}`,
          );
        }
        if (report.missed.length > 0) {
          lines.push('', `${report.missed.length} unanswered:`);
          for (const miss of report.missed.slice(0, 10)) {
            lines.push(`  ${miss.id}  ${miss.ask}`);
            lines.push(`       got: ${miss.got.join(', ') || '(nothing)'}`);
          }
        }
        lines.push(
          '',
          'A branch that changes nothing when removed contributed nothing to these',
          'questions. Read the interval before the percentage: configurations whose',
          'intervals overlap have not been shown to differ.',
        );
        return lines.join('\n');
      });
      return 0;
    }

    case 'doctor': {
      const report = await api.runDoctor();
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatReport(report)}\n`);
        if (report.stale.stale) {
          process.stdout.write(
            `index         WARN    built at ${report.stale.indexed?.slice(0, 8)}, HEAD is ` +
              `${report.stale.head?.slice(0, 8)} -- re-run \`dai-memory ingest\`\n`,
          );
        }
      }
      return report.failed ? 1 : 0;
    }

    case 'register': {
      const project = resolveProject();
      process.stdout.write(`${project.name} at ${project.root}\n`);
      return 0;
    }

    case 'list': {
      const entries = await api.runList();
      emit(args, entries, () =>
        entries.length === 0
          ? 'no registered projects'
          : entries
              .map((e) => {
                const nodes = e.stats ? `${e.stats.nodes} nodes` : 'not indexed';
                const state = e.freshness.unavailable
                  ? `unreachable: ${e.freshness.unavailable}`
                  : e.freshness.stale
                    ? 'STALE - re-run `dai-memory ingest`'
                    : 'current';
                return `${e.name.padEnd(24)}${nodes.padEnd(16)}${state.padEnd(34)}${e.path}`;
              })
              .join('\n'),
      );
      return 0;
    }

    case 'forget': {
      const target = args.positional[0] ?? resolveProject().root;
      const removed = forgetProject(target);
      process.stdout.write(removed ? `forgot ${target}\n` : `not registered: ${target}\n`);
      return removed ? 0 : 1;
    }

    case 'serve': {
      const { serve } = await import('./mcp.js');
      await serve();
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

function formatSearch(result: { results: { title: string; layer: string; sourceRef: string; snippet?: string; score: number; stale?: boolean }[]; fusion: { branches: Record<string, number>; degraded: string[]; reasons: Record<string, string> }; total?: number; omitted?: number; offset?: number }): string {
  const lines: string[] = [];
  const from = result.offset ?? 0;

  for (const [index, hit] of result.results.entries()) {
    lines.push(
      // Numbered from the offset, so a second page does not restart at 1 and
      // read as if it were the first.
      `${String(from + index + 1).padStart(2)}. [${hit.layer}] ${hit.title}${hit.stale ? '  (stale)' : ''}`,
      `    ${hit.sourceRef}`,
    );
    if (hit.snippet) lines.push(`    ${hit.snippet}`);
    lines.push('');
  }

  if (result.results.length === 0) lines.push('no results', '');

  // The tail, and the exact way to see it. A count with no next step is a
  // number the reader can do nothing with.
  if ((result.omitted ?? 0) > 0) {
    lines.push(
      `${result.omitted} more of ${result.total} not shown -- --offset ${from + result.results.length}`,
      '',
    );
  }

  // The fusion report is printed every time, not only when something went wrong:
  // whether a branch was missing changes how far these results should be trusted.
  const branches = Object.entries(result.fusion.branches)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  lines.push(`fusion: ${branches}`);
  if (result.fusion.degraded.length > 0) {
    lines.push(`degraded: ${result.fusion.degraded.join(', ')}`);
    for (const [name, reason] of Object.entries(result.fusion.reasons)) {
      lines.push(`  ${name}: ${reason}`);
    }
  }
  return lines.join('\n');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
