/**
 * Running `init` again.
 *
 * It used to create a store over the existing one. Nothing was deleted -- the
 * recorded decisions survived -- but meta.json was rewritten from scratch: the
 * write counter went back to zero, and the schema version was stamped current
 * before the store was opened, so the migration that reads it had nothing to do.
 * Neither clean nor safe.
 *
 * Now a second `init` rebuilds everything a scan reproduces -- the chunks, the
 * code graph, the keyword index -- from nothing, and keeps everything somebody
 * recorded: decisions, incidents, constraints, summaries, the links between
 * them, and the links from them to the code. `--fresh` removes those too, and
 * only when typed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MemoryStore, readMeta, writeMeta } from '@memory-layer/core';
import { makeRepo, cli, cliRaw, REPO_ROOT } from './helpers.js';

const BILLING = [
  "import { round } from './money.js';",
  '',
  'export function chargeInvoice(invoice) {',
  '  return settle(round(invoice.amount));',
  '}',
  '',
  'export function settle(amount) {',
  '  return amount;',
  '}',
].join('\n');

const FILES = {
  'src/billing.js': BILLING,
  'src/money.js': 'export function round(value) {\n  return Math.round(value);\n}\n',
  'docs/billing.md': '# Billing\n\nRetry a declined card at most twice.\n',
};

function idOf(output) {
  return JSON.parse(output).id;
}

function initJson(repo, args = []) {
  const result = cliRaw(repo, ['init', ...args, '--json']);
  assert.equal(result.status, 0, `init failed:\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

/** A store with one of everything a person records, hanging off everything a scan produces. */
function recorded(repo) {
  cli(repo, ['init']);
  const decision = idOf(cli(repo, [
    'write', '--layer', 'semantic', '--title', 'Settle synchronously',
    '--body', 'Chosen over a queue because refunds need the ledger at once.',
    '--source-ref', 'src/billing.js#L7-L9', '--json',
  ]));
  const incident = idOf(cli(repo, [
    'write', '--layer', 'episodic', '--title', 'Refunds read a stale ledger',
    '--body', 'Queued settlement left the ledger behind for minutes.', '--source-ref', 'session:test', '--json',
  ]));
  const chunk = JSON.parse(cli(repo, ['search', 'declined card', '--json'])).results
    .find((hit) => hit.sourceRef.startsWith('docs/billing.md')).id;

  cli(repo, ['link', decision, incident, 'RESOLVES']);
  cli(repo, ['link', decision, chunk, 'DERIVED_FROM']);
  return { decision, incident, chunk };
}

function edgesOf(repo, id) {
  return JSON.parse(cli(repo, ['get', id, '--json'])).edges;
}

test('a second init keeps what was recorded, and every link it had', () => {
  const repo = makeRepo(FILES);
  try {
    const { decision, incident, chunk } = recorded(repo);
    const outcome = initJson(repo).outcome;

    assert.equal(outcome.mode, 'rebuilt');
    assert.equal(outcome.rebuild.kept, 2, JSON.stringify(outcome.rebuild));

    const edges = edgesOf(repo, decision);
    assert.ok(
      edges.some((e) => e.type === 'RESOLVES' && e.to === incident),
      `the link between two recorded memories was lost: ${JSON.stringify(edges)}`,
    );
    // The chunk was deleted and regenerated. Its id is derived from its text, so
    // an unchanged file gives it back, and the link to it has to come back too.
    assert.ok(
      edges.some((e) => e.type === 'DERIVED_FROM' && e.to === chunk),
      `the link to a regenerated chunk was not restored: ${JSON.stringify(edges)}`,
    );

    // The anchor on the declaration: asking about `settle` still reaches it.
    const why = JSON.parse(cli(repo, ['why', 'settle', '--anchor-only', '--json']));
    assert.ok(
      why.results.some((hit) => hit.id === decision),
      `the decision is no longer anchored to the code it is about: ${JSON.stringify(why.results)}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('a second init rebuilds from nothing, not on top of what was there', () => {
  // The case an incremental ingest cannot fix: a file indexed once, then kept
  // out by a rule added afterwards. It is still on disk, so nothing reclaims
  // it, and the walk no longer visits it, so nothing replaces it. Only a
  // rebuild from nothing lets the rule take effect on what came before.
  const repo = makeRepo({ ...FILES, 'notes/scratch.md': '# Scratch\n\nA passing thought about vendors.\n' });
  try {
    cli(repo, ['init']);
    const before = JSON.parse(cli(repo, ['search', 'passing thought vendors', '--json'])).results;
    assert.ok(before.some((hit) => hit.sourceRef.startsWith('notes/')), 'setup: the note was never indexed');

    fs.writeFileSync(path.join(repo.dir, '.memignore'), 'notes/\n');
    cli(repo, ['ingest']);
    const incremental = JSON.parse(cli(repo, ['search', 'passing thought vendors', '--json'])).results;
    assert.ok(
      incremental.some((hit) => hit.sourceRef.startsWith('notes/')),
      'setup: an ordinary ingest already removed it, so this would prove nothing',
    );

    initJson(repo);
    const after = JSON.parse(cli(repo, ['search', 'passing thought vendors', '--json'])).results;
    assert.ok(
      !after.some((hit) => hit.sourceRef.startsWith('notes/')),
      `a chunk the scan no longer produces survived the rebuild: ${JSON.stringify(after.map((h) => h.sourceRef))}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('the write counter never goes backwards across a second init', () => {
  // A reader holds a snapshot and reopens only when the counter moves. Moving it
  // backwards can land it on the number the reader already holds, and the reader
  // then serves the old snapshot as current.
  const repo = makeRepo(FILES);
  try {
    recorded(repo);
    const before = readMeta(path.join(repo.dir, '.memory')).writeSeq;
    initJson(repo);
    const after = readMeta(path.join(repo.dir, '.memory')).writeSeq;
    assert.ok(after > before, `writeSeq went from ${before} to ${after}`);

    initJson(repo, ['--no-scan']);
    const refreshed = readMeta(path.join(repo.dir, '.memory')).writeSeq;
    assert.ok(refreshed > after, `writeSeq went from ${after} to ${refreshed} on --no-scan`);
  } finally {
    repo.cleanup();
  }
});

test('a second init on an older store runs its migration', () => {
  // Built to look like a version-6 store: a File table from before it had the
  // `uses` column. Stamping the schema current before opening skipped the
  // migration, the old table stayed, and every file row written after failed.
  const repo = makeRepo(FILES);
  const dir = path.join(repo.dir, '.memory');
  try {
    cli(repo, ['init']);

    // In a child process, not this one: on Windows a closed LadybugDB handle
    // keeps its lock until the process that held it exits, and the init below
    // would find the store locked by the test itself.
    const core = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js')).href;
    const surgery = [
      `const { MemoryStore } = await import(${JSON.stringify(core)});`,
      `const store = new MemoryStore(${JSON.stringify(dir)});`,
      "await store.query('DROP TABLE IMPORTS');",
      "await store.query('DROP TABLE DECLARES');",
      "await store.query('DROP TABLE File');",
      "await store.query('CREATE NODE TABLE File(path STRING, language STRING, container STRING, PRIMARY KEY(path))');",
      "await store.query('CREATE REL TABLE DECLARES(FROM File TO Symbol)');",
      "await store.query('CREATE REL TABLE IMPORTS(FROM File TO File, module STRING)');",
      'await store.close();',
    ].join('\n');
    const done = spawnSync(process.execPath, ['--input-type=module', '-e', surgery], { encoding: 'utf8' });
    assert.equal(done.status, 0, `could not build the old-shaped store:\n${done.stderr}`);
    writeMeta(dir, { ...readMeta(dir), schemaVersion: 6 });

    const result = initJson(repo);
    assert.equal(readMeta(dir).schemaVersion, 7);
    assert.equal(result.scanned.relations.failed ?? 0, 0, JSON.stringify(result.scanned.relations));

    const map = JSON.parse(cli(repo, ['map', '--json']));
    assert.ok(
      map.relations.imports > 0,
      `no import edges after re-init -- the old File table was kept: ${JSON.stringify(map.relations)}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('--no-scan brings a store up to date without clearing anything', () => {
  const repo = makeRepo(FILES);
  try {
    cli(repo, ['init']);
    const { outcome } = initJson(repo, ['--no-scan']);
    assert.equal(outcome.mode, 'refreshed');
    const hits = JSON.parse(cli(repo, ['search', 'declined card', '--json'])).results;
    assert.ok(hits.some((hit) => hit.sourceRef.startsWith('docs/')), '--no-scan cleared what it had no way to rebuild');
  } finally {
    repo.cleanup();
  }
});

test('a recorded link whose chunk did not come back is named, not silently dropped', () => {
  const repo = makeRepo(FILES);
  try {
    const { decision, chunk } = recorded(repo);
    // The chunk's text changes, so its regenerated id is a different id.
    fs.writeFileSync(path.join(repo.dir, 'docs', 'billing.md'), '# Billing\n\nRetry a declined card once.\n');

    const outcome = initJson(repo).outcome;
    assert.deepEqual(
      outcome.rebuild.droppedLinks,
      [{ from: decision, to: chunk, type: 'DERIVED_FROM' }],
      JSON.stringify(outcome.rebuild),
    );
    // The decision itself is untouched; only the link to text that no longer
    // exists is gone.
    assert.ok(JSON.parse(cli(repo, ['get', decision, '--json'])).node);
  } finally {
    repo.cleanup();
  }
});

test('--fresh removes the recorded memories too', () => {
  const repo = makeRepo(FILES);
  try {
    const { decision } = recorded(repo);
    const outcome = initJson(repo, ['--fresh']);
    assert.equal(outcome.outcome.wiped, true);
    assert.equal(outcome.outcome.mode, 'created');

    const found = cliRaw(repo, ['get', decision]);
    assert.notEqual(found.status, 0, 'a recorded decision survived --fresh');
    // And the store that replaced it works: the scan went in.
    const hits = JSON.parse(cli(repo, ['search', 'declined card', '--json'])).results;
    assert.ok(hits.length > 0);
  } finally {
    repo.cleanup();
  }
});

test('a different vector width is refused on an existing store, and nothing changes', () => {
  const repo = makeRepo(FILES);
  try {
    const { decision } = recorded(repo);
    const result = cliRaw(repo, ['init', '--dims', '512']);
    assert.notEqual(result.status, 0, 'a width change was accepted in place');
    assert.match(result.stderr, /--fresh/, result.stderr);
    assert.ok(JSON.parse(cli(repo, ['get', decision, '--json'])).node, 'the refused init changed the store');
  } finally {
    repo.cleanup();
  }
});

test('a store is never created over an existing one', async () => {
  const repo = makeRepo(FILES);
  try {
    cli(repo, ['init', '--no-scan']);
    const dir = path.join(repo.dir, '.memory');
    await assert.rejects(
      MemoryStore.create(dir, { projectName: 'x', projectRoot: repo.dir, dimensions: 384, embedding: null }),
      /already exists/,
    );
  } finally {
    repo.cleanup();
  }
});
