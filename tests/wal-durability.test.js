/**
 * A write that was committed survives the process not closing the store.
 *
 * LadybugDB 0.20.3 and 0.20.4 write a WAL record they cannot replay for a
 * committed list or array value past about 1.3 KB -- 320 floats replay, 336 do
 * not -- and every embedding here is 384. A clean
 * close checkpoints first, so the log is never replayed and nothing shows. Any
 * other exit -- Ctrl+C, the hook killing a command at its time limit, a closed
 * pipe, a crash -- and every later open failed with "Corrupted wal file", reads
 * included, until somebody deleted files by hand.
 *
 * Isolated with plain LadybugDB before any of this was written: CREATE and SET
 * on strings and integers, prepared statements, SIGKILL mid-transaction and an
 * exit with queries still running all replay; a vector write does not.
 *
 * Every test below ends a process without closing the store, on purpose,
 * because that is the only way the defect is ever seen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeRepo, cli, cliRaw, REPO_ROOT } from './helpers.js';

const CORE = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js')).href;
const CORE_PACKAGE = path.join(REPO_ROOT, 'packages', 'core', 'package.json');

/** Runs an ES module script in its own process, so it can end without closing anything. */
function script(lines) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', lines.join('\n')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `helper process failed:\n${result.stderr}`);
  return result.stdout;
}

function seeded() {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n\nRetry a declined card at most twice.\n' });
  cli(repo, ['init']);
  const id = JSON.parse(cli(repo, [
    'write', '--layer', 'semantic', '--title', 'Settle synchronously',
    '--body', 'Chosen over a queue because refunds need the ledger at once.',
    '--source-ref', 'session:test', '--json',
  ])).id;
  return { repo, dir: path.join(repo.dir, '.memory'), id };
}

test('a committed vector write survives the process ending without close', () => {
  const { repo, dir, id } = seeded();
  try {
    // Through MemoryStore, the way every command writes: one transaction that
    // sets an embedding, then gone -- no close, so no checkpoint on the way out.
    const vector = JSON.stringify(Array.from({ length: 384 }, (_, i) => (i === 7 ? 1 : 0)));
    script([
      `const { MemoryStore } = await import(${JSON.stringify(CORE)});`,
      `const store = new MemoryStore(${JSON.stringify(dir)});`,
      `await store.transact(() => store.setEmbedding(${JSON.stringify(id)}, ${vector}, ` +
        "{ model: 'probe', dimensions: 384, provider: 'hash' }));",
      'process.exit(0);',
    ]);

    const opened = cliRaw(repo, ['get', id, '--json']);
    assert.equal(opened.status, 0, `the store did not open after the process ended:\n${opened.stderr}`);
    // Opening is not enough -- a tolerant replay opens and drops the write. The
    // vector itself has to be the one that was written.
    const back = script([
      `const { MemoryStore } = await import(${JSON.stringify(CORE)});`,
      `const store = new MemoryStore(${JSON.stringify(dir)}, { readOnly: true });`,
      `const rows = await store.run('MATCH (m:Memory) WHERE m.id = $id RETURN m.embedding_model AS model, m.embedding[8] AS hot', { id: ${JSON.stringify(id)} });`,
      'console.log(JSON.stringify(rows[0]));',
      'await store.close();',
    ]);
    const row = JSON.parse(back.trim().split('\n').pop());
    assert.equal(row.model, 'probe', `the committed write was not kept: ${back}`);
    assert.equal(Number(row.hot), 1, `the vector read back is not the one written: ${back}`);
  } finally {
    repo.cleanup();
  }
});

/**
 * A log in the state the defect leaves behind, made with LadybugDB directly --
 * a vector SET, committed, and no checkpoint -- the way a store written by an
 * older build of this plugin, or killed in the milliseconds between commit and
 * checkpoint, is left.
 */
function interrupt(dir, id) {
  script([
    "import { createRequire } from 'node:module';",
    `const lbug = createRequire(${JSON.stringify(CORE_PACKAGE)})('@ladybugdb/core');`,
    `const db = new lbug.Database(${JSON.stringify(path.join(dir, 'store.lbug'))}, 0, true, false);`,
    'const conn = new lbug.Connection(db);',
    "await conn.query('BEGIN TRANSACTION');",
    "const st = await conn.prepare('MATCH (m:Memory) WHERE m.id = $id SET m.embedding = $v');",
    `await conn.execute(st, { id: ${JSON.stringify(id)}, v: Array.from({ length: 384 }, () => 0.5) });`,
    "await conn.query('COMMIT');",
    'process.exit(0);',
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'store.lbug.wal')), 'setup: no write-ahead log was left behind');
}

test('a reader refuses an unreplayable log, says how to recover, and touches nothing', () => {
  const { repo, dir, id } = seeded();
  try {
    interrupt(dir, id);
    const wal = path.join(dir, 'store.lbug.wal');
    const before = fs.statSync(wal).size;

    const result = cliRaw(repo, ['search', 'declined card']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be replayed/, result.stderr);
    assert.match(result.stderr, /init --no-scan/, result.stderr);

    // A reader takes no lock, so the log might belong to a writer still running.
    // It must not be moved, truncated or copied from a read.
    assert.equal(fs.statSync(wal).size, before, 'a read-only open changed the log');
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('unreplayable')).length, 0);
  } finally {
    repo.cleanup();
  }
});

test('a writable open recovers, keeps the log, and doctor keeps saying so', () => {
  const { repo, dir, id } = seeded();
  try {
    interrupt(dir, id);

    const recovered = cliRaw(repo, ['init', '--no-scan']);
    assert.equal(recovered.status, 0, `recovery failed:\n${recovered.stderr}`);
    assert.match(recovered.stderr, /Recovered the memory store/, recovered.stderr);

    const copies = fs.readdirSync(dir).filter((f) => f.startsWith('store.lbug.wal.unreplayable-'));
    assert.equal(copies.length, 1, `the unreplayable log was not kept: ${fs.readdirSync(dir)}`);

    // Everything checkpointed before the interruption is intact.
    const found = JSON.parse(cli(repo, ['get', id, '--json']));
    assert.equal(found.node.title, 'Settle synchronously');
    const hits = JSON.parse(cli(repo, ['search', 'declined card', '--json'])).results;
    assert.ok(hits.length > 0, 'search does not work after recovery');

    // Said once on the terminal of whoever ran the command, and after that only
    // doctor can say it -- so doctor has to.
    const report = JSON.parse(cliRaw(repo, ['doctor', '--json']).stdout);
    const check = report.checks.find((c) => c.name === 'interrupted writes');
    assert.equal(check?.status, 'warn', JSON.stringify(check));
    assert.match(check.detail, /unreplayable-/, check.detail);
  } finally {
    repo.cleanup();
  }
});

test('canary: the installed LadybugDB still needs the checkpoint after commit', () => {
  // The per-commit checkpoint in MemoryStore.transact exists for one upstream
  // defect, and costs about a fifth of ingest time (measured: 93 s without it,
  // 110-113 s with it, on this repository). This reproduces the defect with
  // LadybugDB alone. When an upgrade fixes it -- the 0.21 development builds
  // already do -- this test fails, and that failure is the signal to remove the
  // checkpoint and this test together, not to make the test pass again.
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, '..', 'walcanary-'));
  try {
    const db = path.join(dir, 'canary.lbug');
    const open = [
      "import { createRequire } from 'node:module';",
      `const lbug = createRequire(${JSON.stringify(CORE_PACKAGE)})('@ladybugdb/core');`,
      `const db = new lbug.Database(${JSON.stringify(db)}, 0, true, false);`,
      'const conn = new lbug.Connection(db);',
    ];
    script([
      ...open,
      // The store's own width. Width is the trigger: measured, 320 floats replay
      // and 336 do not, so a narrow probe passes on the broken release too --
      // which is exactly what the first version of this canary did.
      "await conn.query('CREATE NODE TABLE Item(id STRING, v FLOAT[384], PRIMARY KEY(id))');",
      "await conn.query(\"CREATE (:Item {id: 'a'})\");",
      'await conn.close(); await db.close();',
    ]);
    script([
      ...open,
      "await conn.query('BEGIN TRANSACTION');",
      `await conn.query("MATCH (i:Item) WHERE i.id = 'a' SET i.v = [${Array(384).fill('1.0').join(',')}]");`,
      "await conn.query('COMMIT');",
      'process.exit(0);',
    ]);
    const version = script([...open, 'console.log(lbug.VERSION); await conn.close(); await db.close();']).trim();
    const reopened = spawnSync(process.execPath, ['--input-type=module', '-e', [
      ...open,
      "try { await conn.query('RETURN 1'); console.log('replayed'); } catch (err) { console.log(`failed: ${err.message}`); }",
    ].join('\n')], { encoding: 'utf8' });

    assert.match(
      reopened.stdout,
      /failed: .*(corrupted wal file|wal file is corrupted)/i,
      `LadybugDB ${version} now replays a committed vector write. The upstream defect is fixed: ` +
        'remove the CHECKPOINT in MemoryStore.transact and this canary, and measure ingest again.\n' +
        reopened.stdout,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
