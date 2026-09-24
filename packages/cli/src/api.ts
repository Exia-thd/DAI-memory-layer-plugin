import fs from 'node:fs';
import nodePath from 'node:path';
import {
  MemoryStore, StoreLockedError, ingest, search, neighbors, clusters, conflicts, doctor,
  probeCapabilities, selectProvider, expectedIdentity, parseDimensions, upsertProject, journal,
  readMeta, updateMeta, samePath, globalDir, PLUGIN_DIR_NAME, TOKENIZER_VERSION,
  type StoreMeta,
  nodeId, redact, type EmbeddingProvider, type Layer, type EdgeType, type MemoryNode,
  type SearchResult, type Subgraph, type Conflict, type Cluster, type DoctorReport,
  type IngestReport, log,
} from '@memory-layer/core';
import {
  resolveProject, storeDirFor, ensureGitignore, storeDirOrThrow, isStale, isStaleAsync,
  mapWithLimit, changedFiles, type Staleness,
} from './project.js';
import { readRegistry, type RegistryEntry } from '@memory-layer/core';

/**
 * One implementation of each capability, shared by the CLI and the MCP server.
 *
 * Both front ends call these functions; neither reimplements one. Two code paths
 * for the same operation is how they drift until one of them is wrong.
 */

let cachedProvider: { provider: EmbeddingProvider; capability: unknown } | null = null;

/**
 * The embedder, or an error naming what is missing.
 *
 * It returned null when the model could not be had, and every caller carried on
 * without it: search ran with the semantic branch reported as degraded, a
 * written memory was stored without a vector and never found by meaning again.
 * Each of those was declared somewhere, and none of them was an error -- which
 * is how a machine without the model looked like a machine where search was
 * merely not very good. The model is required, so its absence stops the command.
 */
export async function embedder(dimensions: number): Promise<EmbeddingProvider> {
  if (cachedProvider) return cachedProvider.provider;
  cachedProvider = await selectProvider(dimensions);
  return cachedProvider.provider;
}

export interface InitOptions {
  from?: string;
  dimensions?: string | number;
  seed?: string[];
}

/**
 * What `init` did to the store, in words a person can check.
 *
 * `created` is a new store. `rebuilt` means everything a scan reproduces was
 * cleared and scanned again, and everything somebody recorded was kept.
 * `refreshed` is `--no-scan` on an existing store: brought up to date, nothing
 * rebuilt, because there was nothing to rebuild it from.
 */
export interface InitOutcome {
  mode: 'created' | 'rebuilt' | 'refreshed';
  /** True when `--fresh` removed an existing store first. */
  wiped: boolean;
  rebuild: null | {
    cleared: number;
    kept: number;
    linksRestored: number;
    anchorsRestored: number;
    droppedLinks: Array<{ from: string; to: string; type: string }>;
    droppedAnchors: Array<{ memoryId: string; symbolId: string }>;
  };
}

export async function init(
  options: InitOptions & { scan?: string[]; ui?: boolean; fresh?: boolean } = {},
): Promise<{
  storeDir: string;
  report: DoctorReport;
  scanned: IngestReport | null;
  page: string | null;
  outcome: InitOutcome;
}> {
  const project = resolveProject(options.from);
  const dir = storeDirFor(project.root);
  const existing = MemoryStore.exists(dir) && !options.fresh;

  // An existing store's width is a schema decision already taken. Asking for a
  // different one is a request for a different store, which is what --fresh is.
  let recorded: StoreMeta | null = null;
  if (existing) {
    try {
      recorded = readMeta(dir);
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
        'Run `init --fresh` to replace it. That removes the recorded memories too.',
      );
    }
  }
  const requested = options.dimensions ?? process.env.MEMORY_LAYER_DIMS;
  const dimensions = recorded ? recorded.dimensions : parseDimensions(requested);
  if (recorded && requested !== undefined && parseDimensions(requested) !== recorded.dimensions) {
    throw new Error(
      `This store holds ${recorded.dimensions}-dimension vectors, and width cannot change in ` +
      'place. Run `init --fresh` to start a store of a different width -- that removes the ' +
      'recorded memories too.',
    );
  }

  // The model comes before anything on disk is touched. Above all before --fresh
  // removes a store: a wipe followed by a failed download is a person left with
  // no store at all.
  //
  // `init` may download: on a new machine it is the first command anyone runs.
  const choice = await selectProvider(dimensions, { allowDownload: true }).catch((err: unknown) => {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
      (existing || MemoryStore.exists(dir)
        ? 'Nothing was changed: the existing store is as it was.\n'
        : 'No store was created. The embedding model is part of the install, not an ' +
          'optional extra.\n') +
      'Run `node bin/setup.mjs` with network access, then `init` again.',
    );
  });
  cachedProvider = choice;
  const identity = choice.provider.identity;

  const wiped = Boolean(options.fresh) && MemoryStore.exists(dir);
  if (wiped) removeStore(dir, project.root);

  const capabilities = await probeCapabilities(dir);
  capabilities.embeddings = choice.capability;

  const projectMeta = {
    projectName: project.name,
    projectRoot: project.root,
    remoteUrl: project.remoteUrl,
    branch: project.branch,
    lastCommit: project.lastCommit,
    capabilities,
  };

  // The store stays open from here to the end of init. A LadybugDB path opened
  // once in a process cannot be opened a second time in it, so doctor has to run
  // on this handle rather than on one of its own.
  //
  // An existing store is opened, never created over: opening runs its schema
  // migration, and creating reset its write counter.
  const store = existing
    ? new MemoryStore(dir)
    : await MemoryStore.create(dir, {
        ...projectMeta,
        dimensions,
        embedding: { model: identity.model, provider: identity.provider },
      });

  ensureGitignore(project.root, '.memory');
  upsertProject({
    name: project.name,
    path: project.root,
    storagePath: dir,
    remoteUrl: project.remoteUrl,
    branch: project.branch,
    lastCommit: project.lastCommit,
    indexedAt: new Date().toISOString(),
  });

  const scan = options.scan ?? [];
  const outcome: InitOutcome = {
    mode: existing ? (scan.length > 0 ? 'rebuilt' : 'refreshed') : 'created',
    wiped,
    rebuild: null,
  };

  // Scanning happens on this handle, not a fresh one.
  //
  // A LadybugDB path can be opened for writing once per process, so an init that
  // closed and then called runIngest would take the lock against itself -- which
  // is exactly what the first attempt did. Passing the open store through is the
  // only way to do both in one command.
  let scanned: IngestReport | null = null;
  if (outcome.mode === 'rebuilt') {
    // Recorded memories keep their text and are embedded again in the current
    // space: a vector is reproducible from its text, and a store whose kept
    // memories sit in an older space than its new chunks is the drift doctor
    // exists to catch. Embedded before the transaction, which holds the lock.
    const kept = (await store.allNodes(true)).filter((node) => node.layer !== 'artifact');
    const vectors = kept.length > 0
      ? await choice.provider.embed(kept.map((node) => `${node.title}\n${node.body}`))
      : [];

    const cleared = await store.transact(async () => {
      const result = await store.clearDerived();
      for (let i = 0; i < kept.length; i++) {
        const vector = vectors[i];
        if (!vector) throw new Error(`The embedding model returned no vector for "${kept[i]!.title}".`);
        await store.setEmbedding(kept[i]!.id, vector, identity);
      }
      return result;
    }, {
      ...projectMeta,
      embedding: { model: identity.model, provider: identity.provider },
      // Every file is read again: the chunks they produced are gone.
      fileHashes: {},
      tokenizerVersion: TOKENIZER_VERSION,
    });

    scanned = await ingest(store, scan, { layer: 'artifact', force: false, embedder: choice.provider });
    const restored = await store.transact(() => store.restoreRecorded(cleared.links));

    outcome.rebuild = {
      cleared: cleared.cleared,
      kept: kept.length,
      linksRestored: restored.edges,
      anchorsRestored: restored.anchors,
      droppedLinks: restored.droppedEdges.map(({ from, to, type }) => ({ from, to, type })),
      droppedAnchors: restored.droppedAnchors.map(({ memoryId, symbolId }) => ({ memoryId, symbolId })),
    };
  } else if (outcome.mode === 'refreshed') {
    await store.transact(async () => null, projectMeta);
  } else if (scan.length > 0) {
    scanned = await ingest(store, scan, { layer: 'artifact', force: false, embedder: choice.provider });
  }

  const report = await doctor(store, identity);

  // Built here for the same reason the scan is: closing this handle does not
  // release the file at once on Windows, so a viewer that opened its own store
  // succeeded or failed depending on timing.
  let page: string | null = null;
  if (scanned && options.ui !== false) {
    try {
      const { buildUi } = await import('./ui.js');
      page = (await buildUi(store, dir)).file;
    } catch (err) {
      log('warn', 'could not write the viewer', err);
    }
  }

  await store.close();
  return { storeDir: dir, report, scanned, page, outcome };
}

/**
 * Removes a project's store for `init --fresh`, or refuses with nothing touched.
 *
 * Renamed first, deleted second. A store another process has open -- a Claude
 * Code session with the plugin loaded holds it -- has locked files, and deleting
 * in place would remove whatever was not locked and leave a store with its
 * meta.json gone and its database still there. A rename of the directory either
 * happens whole or fails whole.
 *
 * The target is checked to be this project's store directory and not the global
 * one. A project rooted at the home directory would otherwise share a path with
 * the registry and the model cache, and --fresh would take those with it.
 */
function removeStore(dir: string, projectRoot: string): void {
  if (!samePath(dir, storeDirFor(projectRoot)) || nodePath.basename(dir) !== PLUGIN_DIR_NAME) {
    throw new Error(`Refusing to remove ${dir}: it is not this project's memory store.`);
  }
  if (samePath(dir, globalDir())) {
    throw new Error(
      `Refusing to remove ${dir}: it is also the global directory holding the registry and the ` +
      'model cache, so --fresh would remove those too.',
    );
  }

  const aside = `${dir}.removing-${Date.now()}`;
  try {
    fs.renameSync(dir, aside);
  } catch (err) {
    throw new Error(
      `Could not remove ${dir} (${err instanceof Error ? err.message : String(err)}). Nothing was ` +
      'changed. Something has this store open -- usually a Claude Code session with the plugin ' +
      'loaded. Close it and run `init --fresh` again.',
    );
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    // The store is already out of the way, so init can go on; what is left is
    // disk space, and it is named rather than forgotten.
    log('warn', `the previous store was moved to ${aside} but could not be deleted`, err);
  }
}

export async function runIngest(
  targets: string[],
  options: {
    from?: string; layer?: Layer; force?: boolean; maxFileBytes?: number;
  } = {},
): Promise<IngestReport> {
  const store = await writable(options.from);
  try {
    const provider = await embedder(store.dimensions);
    const report = await ingest(store, targets, {
      layer: options.layer ?? 'artifact',
      force: options.force ?? false,
      maxFileBytes: options.maxFileBytes,
      embedder: provider,
    });
    // A full scan read every file the working tree has, so the graph is this
    // commit's and the store says so. Before this, ingest wrote back whatever
    // commit `init` had recorded: `status` then reported "the working tree has
    // moved on" for ever, every session re-ingested on that word, and anything
    // reading meta.json for freshness -- the harness's docs hub among them --
    // was told a current index was stale.
    //
    // A scan of named paths is not the whole tree, so it leaves the commit
    // alone: claiming this one would call a partial index current.
    const project = resolveProject(options.from);
    // The whole tree is either nothing named or the root itself: the CLI sends
    // `['.']` for the daily `dai-memory ingest`.
    const wholeTree = targets.length === 0
      || targets.every((target) => samePath(nodePath.resolve(project.root, target), project.root));
    const meta = wholeTree
      ? updateMeta(store.dir, { lastCommit: project.lastCommit, branch: project.branch })
      : store.getMeta();
    upsertProject({
      name: meta.projectName,
      path: meta.projectRoot,
      storagePath: store.dir,
      remoteUrl: meta.remoteUrl,
      branch: meta.branch,
      lastCommit: meta.lastCommit,
      indexedAt: new Date().toISOString(),
      stats: await store.stats(),
    });
    return report;
  } finally {
    await store.close();
  }
}

export async function runSearch(
  query: string,
  options: {
    from?: string; limit?: number; offset?: number; layers?: Layer[];
    /** Branch names to switch off, for measuring what each one contributes. */
    disable?: string[];
    disableBm25?: boolean;
  } = {},
): Promise<SearchResult> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const provider = await embedder(store.dimensions);
    const off = new Set(options.disable ?? []);
    return await search(store, query, provider, {
      limit: options.limit ?? 10,
      offset: options.offset,
      layers: options.layers,
      // A branch cannot be shown to earn its place until it can be taken away.
      disableBm25: options.disableBm25 || off.has('bm25'),
      disableSemantic: off.has('semantic'),
      disableEntity: off.has('entity'),
      disableGraph: off.has('graph'),
    });
  } finally {
    await store.close();
  }
}

export const EVAL_FILE = '.memory-eval.json';

export interface EvalQuestion {
  id: string;
  kind?: string;
  ask: string;
  /** A second phrasing. Without one this measures wording, not understanding. */
  also?: string;
  /** Source-ref fragments that count as the right answer. */
  expect: string[];
  /** Fragments that are plausible and wrong. The column that makes the score mean something. */
  reject?: string[];
}

export interface EvalRow {
  label: string;
  asked: number;
  found: number;
  rejected: number;
  /** Wilson 95% interval on the recall rate. */
  low: number;
  high: number;
}

export interface EvalReport {
  questions: number;
  topK: number;
  rows: EvalRow[];
  /** Questions no configuration answered, which are the ones worth reading. */
  missed: { id: string; ask: string; got: string[] }[];
}

/**
 * A two-sided 95% Wilson interval.
 *
 * Five of six and seventeen of twenty are both about 85%, and only one of them
 * is a finding. Printing the width is the report declining to let a small set
 * pass for evidence.
 */
function wilson(successes: number, total: number): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * Scores retrieval against a set of questions whose answer is already known.
 *
 * The test suite answers "does this do what it was built to do". This answers
 * the one none of those touch: does it find the right thing. A store can pass
 * every test and return the wrong document.
 *
 * The set lives in the user's repository rather than in this package, for the
 * same reason `.memignore` does: the questions name files in *their* project
 * and the right answers are theirs to know. A set shipped with the plugin would
 * measure the plugin's own documentation, which is a different question and one
 * nobody asked.
 *
 * Each configuration disables one branch, because a branch cannot be shown to
 * earn its place until it can be taken away. If recall holds when a branch is
 * removed, that branch contributed nothing to these questions -- which is a
 * fact about the questions as much as about the branch, and worth seeing either
 * way.
 */
export async function runEval(
  options: { from?: string; topK?: number } = {},
): Promise<EvalReport> {
  const project = resolveProject(options.from);
  const file = nodePath.join(project.root, EVAL_FILE);

  let parsed: { questions?: EvalQuestion[] } | EvalQuestion[];
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `No question set at ${file}. ` +
        'Write one: each entry needs `ask`, `expect` (source-ref fragments that are ' +
        'correct) and ideally `also` (the same question worded differently) and ' +
        '`reject` (fragments that are plausible and wrong). ' +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const questions = Array.isArray(parsed) ? parsed : parsed.questions ?? [];
  if (questions.length === 0) throw new Error(`${file} contains no questions.`);

  const topK = options.topK ?? 5;
  const configurations: Array<{ label: string; disable: string[] }> = [
    { label: 'all branches', disable: [] },
    { label: 'without bm25', disable: ['bm25'] },
    { label: 'without semantic', disable: ['semantic'] },
    { label: 'without entity', disable: ['entity'] },
    { label: 'without graph', disable: ['graph'] },
  ];

  const rows: EvalRow[] = [];
  const missed: EvalReport['missed'] = [];

  for (const configuration of configurations) {
    let asked = 0;
    let found = 0;
    let rejected = 0;

    for (const question of questions) {
      for (const phrasing of [question.ask, question.also].filter(Boolean) as string[]) {
        asked += 1;
        const result = await runSearch(phrasing, {
          from: options.from,
          limit: topK,
          disable: configuration.disable,
        });
        const refs = result.results.map((hit) => hit.sourceRef ?? '');

        const hit = question.expect.some((want) => refs.some((ref) => ref.includes(want)));
        if (hit) found += 1;
        if ((question.reject ?? []).some((bad) => refs.some((ref) => ref.includes(bad)))) {
          rejected += 1;
        }
        // Only the full configuration decides what counts as unanswerable.
        if (!hit && configuration.disable.length === 0) {
          missed.push({ id: question.id, ask: phrasing, got: refs.slice(0, 3) });
        }
      }
    }

    rows.push({ label: configuration.label, asked, found, rejected, ...wilson(found, asked) });
  }

  return { questions: questions.length, topK, rows, missed };
}

export interface IndexEntry {
  id: string;
  title: string;
  layer: string;
  sourceRef: string;
  stale?: boolean;
}

export interface IndexResult {
  results: IndexEntry[];
  total: number;
  omitted: number;
  offset: number;
  fusion: SearchResult['fusion'];
}

/**
 * The same ranking, at a fifth of the cost per result.
 *
 * A full hit carries a 220-character snippet and runs about sixty tokens. On a
 * four-hundred-token budget that buys six of them, which is why the hook could
 * only ever show a handful and then apologise for the rest. Dropping the
 * snippet leaves title, layer and source_ref -- roughly fifteen tokens, so the
 * same budget covers twenty-six.
 *
 * That is the whole idea: decide what to read *from* a list you can see, rather
 * than being handed the first few in full and told there were more. The
 * snippets are still there; `dai-memory search` and `dai-memory get` fetch them for the
 * entries worth opening.
 */
export async function runIndex(
  query: string,
  options: { from?: string; limit?: number; offset?: number; layers?: Layer[] } = {},
): Promise<IndexResult> {
  const found = await runSearch(query, {
    from: options.from,
    limit: options.limit ?? 30,
    offset: options.offset,
    layers: options.layers,
  });

  return {
    results: found.results.map((hit) => ({
      id: hit.id,
      title: hit.title,
      layer: hit.layer,
      sourceRef: hit.sourceRef,
      ...(hit.stale ? { stale: true } : {}),
    })),
    total: found.total ?? found.results.length,
    omitted: found.omitted ?? 0,
    offset: found.offset ?? 0,
    fusion: found.fusion,
  };
}

export async function runGet(id: string, options: { from?: string } = {}): Promise<{
  node: MemoryNode;
  edges: Awaited<ReturnType<MemoryStore['edgesFor']>>;
} | null> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const node = await store.getNode(id);
    if (!node) return null;
    return { node, edges: await store.edgesFor([id]) };
  } finally {
    await store.close();
  }
}

/**
 * Decisions and constraints touching a file or symbol.
 *
 * This is the question someone actually asks when they open unfamiliar code, and
 * the one nothing else in the toolchain answers.
 */
export async function runWhy(
  target: string,
  options: { from?: string; limit?: number; offset?: number; anchorOnly?: boolean } = {},
): Promise<SearchResult & { anchoredTo: string }> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    // Loading the embedding model costs about 2.5 seconds, and the hook that
    // fires on every Read, Grep and Glob only ever needed the anchor branch --
    // one Cypher query. It was paying for a model it did not use, on every file
    // the agent touched. `anchorOnly` skips constructing the provider at all;
    // the skipped branch is still declared, because a branch that quietly does
    // not run is the failure C4 exists to stop.
    const provider = options.anchorOnly ? null : await embedder(store.dimensions);
    const limit = options.limit ?? 10;

    // Anchor on provenance first, filtered in the database rather than by reading
    // every node. A path anchors on file_path or source_ref; a bare symbol has
    // neither, so it falls through to the text branches below.
    // A path anchors on provenance; a bare name anchors on the declaration the
    // chunker recorded. Before symbols existed the second case had nothing to
    // hold on to and quietly became a text search over prose that may never
    // mention the symbol.
    const anchored = looksLikePath(target)
      ? await store.nodesAnchoredToPath(target)
      : await store.nodesAboutSymbol(target);

    // Then widen by wording, so a symbol name works as well as a path.
    const found = await search(store, target.replace(/[/_.\\-]+/g, ' '), provider, {
      // No offset here. Paging is applied once, after the anchored hits merge
      // in -- paging twice would skip a different set than the caller asked for
      // on any file that carries recorded reasoning.
      limit: limit + Math.max(0, options.offset ?? 0),
      layers: ['semantic', 'episodic', 'procedural'],
    });

    // Explaining code means explaining decisions, so anchored reasoning leads --
    // including a node the text branches also found, which would otherwise be
    // ranked below one that only anchored.
    const anchoredIds = new Set(anchored.map((node) => node.id));
    const lead = [...anchored]
      .sort((a, b) => rank(a) - rank(b) || b.importance - a.importance)
      .map((node) => ({
        id: node.id,
        title: node.title,
        score: Number.POSITIVE_INFINITY,
        layer: node.layer,
        sourceRef: node.sourceRef,
        snippet: node.body.slice(0, 220),
        createdAt: node.createdAt,
        ranks: { anchor: 1 },
      }));

    const merged = [...lead, ...found.results.filter((hit) => !anchoredIds.has(hit.id))];
    // Paged once, here, over the merged order.
    const offset = Math.max(0, options.offset ?? 0);
    found.results = merged.slice(offset, offset + limit);
    found.offset = offset;
    // Anchored hits are found here, not by `search`, so the totals it returned
    // do not know about them. Recount after the merge or the number is a lie in
    // exactly the case that matters -- a file with a lot of recorded reasoning.
    found.total = Math.max(found.total ?? 0, merged.length);
    found.omitted = Math.max(0, found.total - (offset + found.results.length));

    // Anchoring is a retrieval branch and is reported as one; otherwise a result
    // set answered entirely by anchors reads as "every branch found nothing".
    found.fusion.branches.anchor = anchored.length;
    if (options.anchorOnly) {
      // Said out loud: this run never asked the semantic branch, which is not
      // the same as asking and getting nothing back.
      if (!found.fusion.degraded.includes('semantic')) found.fusion.degraded.push('semantic');
      found.fusion.reasons.semantic =
        'Skipped: --anchor-only avoids loading the embedding model, which costs about 2.5s.';
    }
    if (anchored.length === 0) {
      found.fusion.degraded.push('anchor');
      found.fusion.reasons.anchor = looksLikePath(target)
        ? `No memory is recorded against ${target}.`
        : `No declaration named ${target} carries recorded memory; this is a text search.`;
    }

    return { ...found, anchoredTo: target };
  } finally {
    await store.close();
  }
}

/** A path has a separator or an extension; a bare symbol has neither. */
function looksLikePath(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.[a-z0-9]{1,6}$/i.test(target);
}

/** Decisions and constraints before the events that prompted them. */
function rank(node: MemoryNode): number {
  return { semantic: 0, procedural: 1, episodic: 2, artifact: 3 }[node.layer] ?? 4;
}

export async function runNeighbors(
  id: string,
  options: { from?: string; depth?: number; edgeTypes?: EdgeType[] } = {},
): Promise<Subgraph> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await neighbors(store, id, { depth: options.depth, edgeTypes: options.edgeTypes });
  } finally {
    await store.close();
  }
}

export interface WriteInput {
  layer: Layer;
  title: string;
  body: string;
  sourceRef: string;
  importance?: number;
  confidence?: number;
  filePath?: string;
  links?: { to: string; type: EdgeType; weight?: number }[];
}

/**
 * Records a memory, falling back to the session journal when another process
 * holds the write lock.
 *
 * The fallback is reported to the caller rather than hidden: a memory that is
 * written but not yet searchable is a different outcome from one that is live,
 * and the difference matters to whoever wrote it.
 */
/**
 * The open session, if any, so a memory written now can say when it happened.
 *
 * `OCCURRED_IN` existed as an edge label from the start with nothing that could
 * ever create one -- the same shape as an edge type declared in a schema and
 * never produced, which is how a graph ends up with nodes and no relationships.
 * A session node is the missing producer.
 */
function sessionPath(storeDir: string): string {
  return nodePath.join(storeDir, 'session.json');
}

export function currentSession(storeDir: string): { id: string; label: string; startedAt: number } | null {
  try {
    const raw = fs.readFileSync(sessionPath(storeDir), 'utf8');
    const parsed = JSON.parse(raw) as { id: string; label: string; startedAt: number };
    return parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

export async function runSessionStart(
  label: string,
  options: { from?: string } = {},
): Promise<{ id: string; label: string }> {
  const storeDir = storeDirOrThrow(options.from);
  const startedAt = Date.now();
  const written = await runWrite(
    {
      layer: 'episodic',
      title: `Session: ${label}`,
      body: `Work session "${label}" opened at ${new Date(startedAt).toISOString()}.`,
      sourceRef: `session://${startedAt}`,
      importance: 2,
    },
    options,
  );
  fs.writeFileSync(sessionPath(storeDir), JSON.stringify({ id: written.id, label, startedAt }, null, 2));
  return { id: written.id, label };
}

export async function runSessionEnd(
  options: { from?: string; summary?: string } = {},
): Promise<{ closed: string | null }> {
  const storeDir = storeDirOrThrow(options.from);
  const open = currentSession(storeDir);
  if (!open) return { closed: null };

  if (options.summary) {
    await runWrite(
      {
        layer: 'episodic',
        title: `Session outcome: ${open.label}`,
        body: options.summary,
        sourceRef: `session://${open.startedAt}#outcome`,
        importance: 4,
        links: [{ to: open.id, type: 'OCCURRED_IN' as EdgeType, weight: 1 }],
      },
      options,
    );
  }
  fs.rmSync(sessionPath(storeDir), { force: true });
  return { closed: open.id };
}

export async function runWrite(
  input: WriteInput,
  options: { from?: string } = {},
): Promise<{
  id: string;
  queued: boolean;
  redactions: { rule: string; count: number }[];
  /** Declarations the source_ref lands inside, linked automatically. */
  about: string[];
  /** Memories close enough to be worth linking, for a person to decide. */
  related: Array<{ id: string; title: string }>;
}> {
  if (!input.sourceRef) {
    throw new Error('source_ref is required: a memory that cannot be traced back cannot be checked.');
  }

  const { text: body, redactions } = redact(input.body);
  const { text: title } = redact(input.title);
  const now = Date.now();
  const node: MemoryNode = {
    id: nodeId(input.layer, input.sourceRef, body),
    layer: input.layer,
    title,
    body,
    sourceRef: input.sourceRef,
    filePath: input.filePath ?? null,
    importance: input.importance ?? 5,
    confidence: input.confidence ?? 0.8,
    createdAt: now,
    lastSeenAt: now,
    accessCount: 0,
    supersededAt: null,
    embedding: null,
  };

  const storeDir = storeDirOrThrow(options.from);
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);

    // Embed first: the model call is slow, and a write transaction holds the
    // store's exclusive lock for as long as it is open.
    let vector: number[] | null = null;
    // No vector, no write. A memory stored without one is found by its exact
    // wording and never by its meaning, and nothing about it says so.
    const provider = await embedder(store.dimensions);
    vector = (await provider.embed([`${node.title}\n${node.body}`]))[0] ?? null;
    if (!vector) throw new Error(`The embedding model returned no vector for "${node.title}".`);

    // What this source_ref points at, before the write opens a transaction.
    //
    // A hand-written decision could never reach the code graph: ABOUT was
    // produced by ingest and nothing else, so the symbol and the decision about
    // it sat in the same store unconnected. The span in the source_ref answers
    // it exactly -- no guessing, no asking.
    const covered = await symbolsForRef(store, input.sourceRef);

    // Memories near enough to be worth a link, which is a judgement and stays
    // one. Suggested, never created: a wrong edge is worse than a missing one
    // because the graph branch will retrieve through it, and nothing downstream
    // can tell a guessed edge from a considered one.
    const related = vector && provider
      ? await nearbyMemories(store, node, vector, provider.identity)
      : [];

    await store.transact(async () => {
      await store!.upsertNode(node);
      if (vector && provider) await store!.setEmbedding(node.id, vector, provider.identity);

      for (const symbol of covered) {
        await store!.upsertSymbol(symbol);
        await store!.linkAbout(node.id, symbol.id);
      }

      for (const link of sessionLinks(storeDir, node, input.links)) {
        await store!.addEdge({
          from: node.id,
          to: link.to,
          type: link.type,
          weight: link.weight ?? 1,
          createdAt: now,
          evidenceRef: null,
        });
      }
    });

    return { id: node.id, queued: false, redactions, about: covered.map((s) => s.name), related };
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    journal.appendNode(storeDir, node);
    for (const link of sessionLinks(storeDir, node, input.links)) {
      journal.appendEdge(storeDir, {
        from: node.id, to: link.to, type: link.type,
        weight: link.weight ?? 1, createdAt: now, evidenceRef: null,
      });
    }
    // A queued write cannot read the graph, so there is nothing to link or
    // suggest yet. `dai-memory merge` folds the node in; the anchors follow it.
    return { id: node.id, queued: true, redactions, about: [], related: [] };
  } finally {
    await store?.close();
  }
}

/**
 * The declarations a source_ref lands inside.
 *
 * Returns nothing for a ref with no line span, and nothing for a file that has
 * no recorded declarations -- both are ordinary, and neither is worth a warning.
 */
async function symbolsForRef(
  store: MemoryStore,
  sourceRef: string,
): Promise<Array<{ id: string; name: string; filePath: string; kind: string; startLine: number; endLine: number }>> {
  const match = /^(.+?)#L(\d+)(?:-L(\d+))?$/.exec(sourceRef);
  if (!match) return [];

  const [, file, from, to] = match;
  const start = Number(from);
  const end = Number(to ?? from);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  try {
    return await store.symbolsCovering(file!.replace(/\\/g, '/'), start, end);
  } catch (err) {
    // The anchor is a bonus on top of a write that has already succeeded in
    // every other respect. Losing it must not lose the memory.
    log('warn', `could not resolve symbols for ${sourceRef}`, err);
    return [];
  }
}

/**
 * Memories close enough that a link is worth considering.
 *
 * Suggestion rather than creation, on purpose. The graph branch retrieves
 * through edges, so a wrong edge does not sit there harmlessly -- it pulls an
 * unrelated decision into results for the rest of the store's life, and nothing
 * downstream can tell a guessed edge from one somebody meant. Deciding that two
 * decisions bear on each other is the judgement this layer exists to record,
 * and handing it to a cosine score would be recording something else.
 */
async function nearbyMemories(
  store: MemoryStore,
  node: MemoryNode,
  vector: number[],
  identity: { model: string; provider: string },
): Promise<Array<{ id: string; title: string }>> {
  try {
    const near = await store.semanticTopK(vector, {
      limit: 6,
      model: identity.model,
      provider: identity.provider,
      // Chunks of files are not what one links a decision to; ABOUT already
      // covers that, and precisely, from the line span.
      layers: ['semantic', 'episodic', 'procedural'],
    });

    // High enough that the two are plausibly about the same thing. A looser
    // threshold turns this from a short prompt into a list nobody reads, which
    // is the same as no prompt at all.
    const candidates = near.filter((hit) => hit.id !== node.id && hit.similarity >= 0.55);
    if (candidates.length === 0) return [];

    const nodes = await store.getNodes(candidates.slice(0, 3).map((hit) => hit.id));
    return [...nodes.values()].map((found) => ({ id: found.id, title: found.title }));
  } catch (err) {
    log('warn', 'could not look for related memories', err);
    return [];
  }
}

export async function runLink(
  from: string,
  to: string,
  type: EdgeType,
  options: { weight?: number; evidenceRef?: string; from_?: string } = {},
): Promise<{ queued: boolean }> {
  const storeDir = storeDirOrThrow(options.from_);
  const edge = {
    from, to, type,
    weight: options.weight ?? 1,
    createdAt: Date.now(),
    evidenceRef: options.evidenceRef ?? null,
  };

  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);
    await store.transact(async () => store!.addEdge(edge));
    return { queued: false };
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err;
    journal.appendEdge(storeDir, edge);
    return { queued: true };
  } finally {
    await store?.close();
  }
}

/** Folds queued session writes into the store. Skipped, with a reason, when locked. */
export async function runMerge(options: { from?: string } = {}): Promise<{ merged: number; files: number; skipped: string | null }> {
  const storeDir = storeDirOrThrow(options.from);
  const files = journal.pendingFiles(storeDir);
  if (files.length === 0) return { merged: 0, files: 0, skipped: null };

  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(storeDir);

    // A queued write could not reach the store, so it was journalled without a
    // vector -- and merged that way, it became a memory search finds by exact
    // wording and never by meaning. Embedded here, before the transaction takes
    // the lock, and a missing model stops the merge with the journal intact.
    const provider = await embedder(store.dimensions);
    const vectors = new Map<string, number[]>();
    for (const file of files) {
      for (const entry of journal.readEntries(file)) {
        if (entry.kind !== 'node' || !entry.node) continue;
        const [vector] = await provider.embed([`${entry.node.title}\n${entry.node.body}`]);
        if (!vector) throw new Error(`The embedding model returned no vector for "${entry.node.title}".`);
        vectors.set(entry.node.id, vector);
      }
    }

    const merged = await store.transact(async () => {
      let count = 0;
      for (const file of files) {
        for (const entry of journal.readEntries(file)) {
          if (entry.kind === 'node' && entry.node) {
            await store!.upsertNode(entry.node);
            const vector = vectors.get(entry.node.id);
            if (vector) await store!.setEmbedding(entry.node.id, vector, provider.identity);
            count += 1;
          } else if (entry.kind === 'edge' && entry.edge) {
            // An edge whose endpoints never merged is dropped with a reason
            // rather than losing the whole batch to one bad reference.
            try {
              await store!.addEdge(entry.edge);
              count += 1;
            } catch (err) {
              log('warn', 'dropping journal edge with missing endpoint', err);
            }
          }
        }
      }
      return count;
    });

    // Journals are discarded only once the merge is durable; a crash before this
    // point replays them, and upserts are idempotent.
    for (const file of files) journal.discard(file);
    return { merged, files: files.length, skipped: null };
  } catch (err) {
    if (err instanceof StoreLockedError) {
      return { merged: 0, files: files.length, skipped: err.message };
    }
    throw err;
  } finally {
    await store?.close();
  }
}

/**
 * The constraints currently in force: live semantic memories, most important first.
 *
 * Distinct from search because there is no query -- this answers "what rules
 * apply here", which is what a session needs before it has a question.
 */
export interface ListedProject extends RegistryEntry {
  freshness: Staleness;
}

/**
 * Every registered project with its index freshness.
 *
 * The freshness check spawns git per project, so the checks run concurrently
 * with a cap: done one at a time, a large registry turns a listing into a long
 * wait, and a listing nobody is willing to run is a listing that never reports
 * a stale index.
 */
export async function runList(options: { concurrency?: number } = {}): Promise<ListedProject[]> {
  const entries = readRegistry();
  const freshness = await mapWithLimit(entries, options.concurrency ?? 8, (entry) =>
    isStaleAsync(entry.storagePath),
  );
  return entries.map((entry, index) => ({ ...entry, freshness: freshness[index]! }));
}

export async function runConstraints(
  options: { from?: string; limit?: number } = {},
): Promise<MemoryNode[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const nodes = await store.allNodes();
    return nodes
      .filter((node) => node.layer === 'semantic' && !node.supersededAt)
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, options.limit ?? 10);
  } finally {
    await store.close();
  }
}

export interface ChangedFileMemory {
  file: string;
  /**
   * Decisions recorded not about this file, but about code that calls into it.
   *
   * The commit check's blind spot: a constraint lives with the caller -- "this
   * returns null rather than throwing, the caller counts on it" -- and editing
   * the callee showed nothing at all. One hop along the call graph, and each
   * entry says which declaration it came through.
   */
  viaCalls?: Array<{
    id: string;
    layer: Layer;
    title: string;
    sourceRef: string;
    /** The declaration in the changed file that this memory's code reaches. */
    reaches: string;
  }>;
  /** Decisions, constraints and events recorded against this file. */
  memories: Array<{
    id: string;
    layer: Layer;
    title: string;
    sourceRef: string;
    importance: number;
    /** True when this node is one side of an unresolved CONTRADICTS pair. */
    contested: boolean;
  }>;
  /** Memories that matched but were not listed, so the cut is visible. */
  omitted: number;
}

/**
 * Decisions recorded about code that calls into this file.
 *
 * Only recorded memories, never the file chunks: a chunk of a caller is not a
 * reason to stop and read, and a commit check that prints twenty of them is a
 * commit check people turn off.
 */
async function reachedByCalls(
  store: MemoryStore,
  file: string,
  already: string[],
  limit: number,
): Promise<NonNullable<ChangedFileMemory['viaCalls']>> {
  const declared = await store.symbolsInFile(file);
  if (declared.length === 0) return [];

  const ids = declared.map((symbol) => symbol.id);
  const owned = new Set(ids);
  const seen = new Set(already);
  const reaches = new Map<string, string>();
  for (const edge of await store.neighboursOf(ids)) {
    // Callers only: what this file calls is its own business, but what calls
    // into it is what a change here can break.
    if (owned.has(edge.from) || !owned.has(edge.to)) continue;
    reaches.set(edge.from, edge.to);
  }
  if (reaches.size === 0) return [];

  const out: NonNullable<ChangedFileMemory['viaCalls']> = [];
  for (const { node, symbolId } of await store.nodesAboutSymbolIdsAnchored([...reaches.keys()], limit * 4)) {
    if (node.layer === 'artifact' || seen.has(node.id)) continue;
    seen.add(node.id);
    // The declaration this memory's own code calls, not whichever was first.
    const target = reaches.get(symbolId) ?? '';
    out.push({
      id: node.id,
      layer: node.layer,
      title: node.title,
      sourceRef: node.sourceRef,
      reaches: target.replace(/^Symbol:[^:]*:/, ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface ChangesReport {
  scope: 'staged' | 'working' | 'compare';
  baseRef?: string;
  /** Files the diff touched, whether or not memory knows anything about them. */
  changed: string[];
  /** Only the files memory has something to say about. */
  covered: ChangedFileMemory[];
  /** Files with nothing recorded -- reported so silence is visible, not implied. */
  uncovered: string[];
  contested: number;
}

/**
 * What memory knows about the code you are about to commit.
 *
 * This is the moment memory is worth the most: not while exploring, but just
 * before a change lands that may contradict a decision someone already made and
 * wrote down. `uncovered` is reported alongside `covered` because "memory found
 * nothing" and "memory was never asked" look identical otherwise.
 */
export async function runChanges(
  options: {
    from?: string;
    scope?: 'staged' | 'working' | 'compare';
    baseRef?: string;
    perFile?: number;
  } = {},
): Promise<ChangesReport> {
  const project = resolveProject(options.from);
  const perFile = options.perFile ?? 5;
  const scope = options.scope ?? 'staged';
  const files = changedFiles(project.root, scope, options.baseRef);
  if (files === null) {
    throw new Error(
      `Could not read ${scope} changes from git in ${project.root}. ` +
        'An unborn branch or a bad base ref reports no changes, which would read as "nothing to check".',
    );
  }

  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    const contestedIds = new Set<string>();
    for (const conflict of await conflicts(store)) {
      contestedIds.add(conflict.a.id);
      contestedIds.add(conflict.b.id);
    }

    const covered: ChangedFileMemory[] = [];
    const uncovered: string[] = [];

    for (const file of files) {
      const nodes = await store.nodesAnchoredToPath(file);
      const viaCalls = await reachedByCalls(store, file, nodes.map((node) => node.id), perFile);
      if (nodes.length === 0 && viaCalls.length === 0) {
        uncovered.push(file);
        continue;
      }
      if (nodes.length === 0) {
        covered.push({ file, memories: [], omitted: 0, viaCalls });
        continue;
      }
      // Decisions first, then the chunks of the file itself. A commit check that
      // lists fourteen artifact fragments per file floods the context this layer
      // exists to protect -- and buries the one recorded decision that matters.
      const ranked = nodes.sort(
        (a, b) => rank(a) - rank(b) || b.importance - a.importance,
      );
      const reasoning = ranked.filter((node) => node.layer !== 'artifact');
      const shown = (reasoning.length > 0 ? reasoning : ranked).slice(0, perFile);

      covered.push({
        file,
        memories: shown.map((node) => ({
          id: node.id,
          layer: node.layer,
          title: node.title,
          sourceRef: node.sourceRef,
          importance: node.importance,
          contested: contestedIds.has(node.id),
        })),
        omitted: nodes.length - shown.length,
        ...(viaCalls.length > 0 ? { viaCalls } : {}),
      });
    }

    const contested = covered.reduce(
      (total, entry) => total + entry.memories.filter((memory) => memory.contested).length,
      0,
    );
    return { scope, baseRef: options.baseRef, changed: files, covered, uncovered, contested };
  } finally {
    await store.close();
  }
}

export async function runConflicts(options: { from?: string } = {}): Promise<Conflict[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await conflicts(store);
  } finally {
    await store.close();
  }
}

export async function runClusters(options: { from?: string } = {}): Promise<Cluster[]> {
  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  try {
    return await clusters(store);
  } finally {
    await store.close();
  }
}

/**
 * Records a summary somebody wrote for a group of memories.
 *
 * This is the summarisation stage, and it is deliberately not automatic: the
 * body comes from the caller. Nothing here calls a model, so a read path can
 * never quietly become a generation path -- and the summary is linked to the
 * members, not to a community id that changes on the next run.
 */
export async function runSummarize(
  clusterId: number,
  body: string,
  options: { from?: string; title?: string } = {},
): Promise<{ id: string; covers: number }> {
  if (!body.trim()) throw new Error('A summary needs a body; an empty one is worse than none.');

  const store = new MemoryStore(storeDirOrThrow(options.from), { readOnly: true });
  let found: Cluster | undefined;
  try {
    found = (await clusters(store)).find((cluster) => cluster.id === clusterId);
  } finally {
    await store.close();
  }
  if (!found) throw new Error(`No cluster ${clusterId} in the current grouping. Run \`dai-memory clusters\` first.`);

  const title = options.title ?? `Area: ${found.terms.slice(0, 3).join(', ') || `cluster ${clusterId}`}`;
  const written = await runWrite(
    {
      layer: 'semantic',
      title,
      body,
      sourceRef: `cluster://${found.memberIds.length}-members`,
      importance: 6,
      links: found.memberIds.map((id) => ({ to: id, type: 'DERIVED_FROM' as EdgeType, weight: 1 })),
    },
    options,
  );
  return { id: written.id, covers: found.memberIds.length };
}

export interface PruneReport {
  layer: string;
  olderThanDays: number;
  dryRun: boolean;
  /** What was removed, or what would have been. */
  candidates: Array<{ id: string; title: string; ageDays: number }>;
  removed: number;
}

/**
 * Forgetting, on purpose and on the narrowest terms that are useful.
 *
 * Without this there is no way to forget anything, and the automatic write path
 * has to stay off: it records an episodic node for every failed command, most of
 * which are typos, and nothing ever removes them. Decay only lowers their rank --
 * they keep their postings, so they go on diluting IDF for every real memory
 * around them.
 *
 * Three conditions, all required. Episodic only, because a decision does not
 * become noise by getting old. Older than the cutoff. And unreferenced, because
 * a memory something points at is part of somebody's reasoning.
 */
export async function runPrune(
  options: { from?: string; olderThanDays?: number; layer?: string; dryRun?: boolean } = {},
): Promise<PruneReport> {
  const olderThanDays = options.olderThanDays ?? 90;
  const layer = options.layer ?? 'episodic';
  // Fractions are allowed on purpose: a noisy session from an hour ago is a fair
  // thing to clear, and a whole-day floor was an arbitrary number rather than a
  // property. Zero and below are refused, because "older than now" is everything.
  if (!(olderThanDays > 0)) {
    throw new Error('--older-than must be greater than 0; "older than now" would match everything.');
  }

  const storeDir = storeDirOrThrow(options.from);
  const now = Date.now();

  // Read through a read-only handle, so a preview never takes the write lock.
  const reader = new MemoryStore(storeDir, { readOnly: true });
  let candidates: Array<{ id: string; title: string; ageDays: number }>;
  try {
    candidates = (await reader.prunable({ layer, olderThanDays })).map((node) => ({
      id: node.id,
      title: node.title,
      ageDays: Math.floor((now - node.createdAt) / (24 * 60 * 60 * 1000)),
    }));
  } finally {
    await reader.close();
  }

  if (options.dryRun || candidates.length === 0) {
    return { layer, olderThanDays, dryRun: Boolean(options.dryRun), candidates, removed: 0 };
  }

  const store = new MemoryStore(storeDir);
  try {
    const removed = await store.transact(() => store.deleteNodes(candidates.map((c) => c.id)));
    return { layer, olderThanDays, dryRun: false, candidates, removed };
  } finally {
    await store.close();
  }
}

export async function runDoctor(options: { from?: string } = {}): Promise<DoctorReport & { stale: ReturnType<typeof isStale> }> {
  const storeDir = storeDirOrThrow(options.from);
  const store = new MemoryStore(storeDir, { readOnly: true });
  try {
    // Reported, not loaded: doctor is what somebody runs on the machine where
    // the model is missing, so it cannot be the thing that needs the model.
    const report = await doctor(store, expectedIdentity(store.dimensions));
    return { ...report, stale: isStale(storeDir) };
  } finally {
    await store.close();
  }
}

/** Re-embeds nodes that have no vector, or whose vector is from another space. */
export async function runEmbed(options: { from?: string; force?: boolean } = {}): Promise<{ embedded: number; skipped: number }> {
  const store = await writable(options.from);
  try {
    // Re-embedding is an explicit request for the model, so it may fetch it.
    cachedProvider ??= await selectProvider(store.dimensions, { allowDownload: true });
    const provider = cachedProvider.provider;

    const identity = provider.identity;
    const nodes = await store.allNodes();
    let skipped = 0;

    // Every vector is computed before the transaction opens, so the exclusive
    // lock is held for the writes alone rather than for the whole model run.
    const pending: { id: string; vector: number[] }[] = [];
    for (const node of nodes) {
      const current =
        node.embeddingModel === identity.model &&
        node.embeddingProvider === identity.provider &&
        node.embedding?.length === identity.dimensions;
      if (current && !options.force) {
        skipped += 1;
        continue;
      }
      const [vector] = await provider.embed([`${node.title}\n${node.body}`]);
      if (vector) pending.push({ id: node.id, vector });
    }

    // The recorded capability is about this store, not about the run that
    // created it. Embedding into a different space and leaving the old line in
    // place had `doctor` reporting a hash fallback over vectors from the real
    // model -- the store was fine and the report was wrong.
    const capabilities = { ...store.getMeta().capabilities } as Record<string, unknown>;
    capabilities.embeddings = cachedProvider.capability as never;

    await store.transact(
      async () => {
        for (const { id, vector } of pending) await store.setEmbedding(id, vector, identity);
      },
      {
        embedding: { model: identity.model, provider: identity.provider },
        capabilities: capabilities as never,
      },
    );

    return { embedded: pending.length, skipped };
  } finally {
    await store.close();
  }
}

async function writable(from?: string): Promise<MemoryStore> {
  return new MemoryStore(storeDirOrThrow(from));
}

/**
 * The caller's links, plus the open session when there is one.
 *
 * A session node does not occur in itself, so it is excluded by source_ref.
 */
function sessionLinks(
  storeDir: string,
  node: MemoryNode,
  links: WriteInput['links'],
): NonNullable<WriteInput['links']> {
  const explicit = links ?? [];
  if (node.sourceRef.startsWith('session://')) return explicit;

  const open = currentSession(storeDir);
  if (!open) return explicit;
  if (explicit.some((link) => link.to === open.id)) return explicit;
  return [...explicit, { to: open.id, type: 'OCCURRED_IN' as EdgeType, weight: 1 }];
}
