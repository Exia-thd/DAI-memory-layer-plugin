/**
 * What happens to the graph when the code moves.
 *
 * Ingest re-reads the files that changed. Moving a declaration to another file
 * changes two files, but the file that *calls* it is not one of them -- and the
 * old declaration is deleted, taking every edge pointing at it. The caller was
 * then recorded as calling nothing, which is not a gap in the graph but a wrong
 * answer in it: the code plainly calls something, and `map` said it did not.
 *
 * The fix hands those call sites back to the resolver instead of dropping them,
 * so the second pass either finds the declaration in its new home or reports it
 * unresolved. These tests hold both outcomes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryStore, readMeta } from '@memory-layer/core';
import { makeRepo, cli } from './helpers.js';

const CALLER = [
  'import { settle } from "./ledger.js";',
  '',
  'export function chargeInvoice(invoice) {',
  '  return settle(invoice.amount);',
  '}',
].join('\n');

const LEDGER = 'export function settle(amount) {\n  return amount;\n}\n';

function write(repo, relative, content) {
  const full = path.join(repo.dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function callsFrom(repo, callerFile) {
  const store = new MemoryStore(path.join(repo.dir, '.memory'), { readOnly: true });
  try {
    const calls = await store.allCalls();
    return calls.filter((call) => call.from.includes(`/${callerFile}:`));
  } finally {
    await store.close();
  }
}

test('a declaration that moves file keeps the edges pointing at it', async () => {
  const repo = makeRepo({ 'src/billing.js': CALLER, 'src/ledger.js': LEDGER });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    const before = await callsFrom(repo, 'billing.js');
    assert.ok(
      before.some((call) => call.name === 'settle'),
      `the call was never recorded: ${JSON.stringify(before)}`,
    );

    // settle moves to a new file. billing.js is untouched, so nothing re-reads
    // the call site -- which is the whole point of the case.
    fs.rmSync(path.join(repo.dir, 'src', 'ledger.js'));
    write(repo, 'src/accounts.js', LEDGER);
    cli(repo, ['ingest', 'src']);

    const after = await callsFrom(repo, 'billing.js');
    const edge = after.find((call) => call.name === 'settle');
    assert.ok(edge, `the call vanished after the move: ${JSON.stringify(after)}`);
    assert.match(edge.to, /accounts\.js/, `it still points at the old file: ${edge.to}`);
  } finally {
    repo.cleanup();
  }
});

test('a declaration that is deleted outright leaves the call unresolved, not unrecorded', async () => {
  const repo = makeRepo({ 'src/billing.js': CALLER, 'src/ledger.js': LEDGER });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    fs.rmSync(path.join(repo.dir, 'src', 'ledger.js'));
    cli(repo, ['ingest', 'src']);

    // No edge: there is nothing to point at, and inventing one would be worse.
    const after = await callsFrom(repo, 'billing.js');
    assert.ok(!after.some((call) => call.name === 'settle'), JSON.stringify(after));

    // But the call site is still on the books as a question, not forgotten.
    const store = new MemoryStore(path.join(repo.dir, '.memory'), { readOnly: true });
    try {
      const pending = await store.pendingCallsNamed(['settle']);
      assert.ok(
        pending.some((row) => row.filePath.endsWith('billing.js')),
        `the call to a deleted function was forgotten: ${JSON.stringify(pending)}`,
      );
    } finally {
      await store.close();
    }
  } finally {
    repo.cleanup();
  }
});

/**
 * What a full ingest says about which commit the graph is.
 *
 * `init` recorded the commit; `ingest` re-read every file and then wrote the old
 * commit back. `status` therefore said "the working tree has moved on" for ever
 * after the first commit, every session re-ingested on that word, and anything
 * reading meta.json for freshness was told a current index was stale. A scan of
 * named paths is a different thing and must not claim the commit.
 */
test('a full ingest records the commit it read; a partial one does not claim it', async () => {
  const repo = makeRepo({ 'src/billing.js': CALLER, 'src/ledger.js': LEDGER });
  const git = (...args) => execFileSync('git', args, { cwd: repo.dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    cli(repo, ['init']);
    const indexedAtInit = readMeta(path.join(repo.dir, '.memory')).lastCommit;
    assert.equal(indexedAtInit, git('rev-parse', 'HEAD'));

    write(repo, 'src/ledger.js', `${LEDGER}export function refund(amount) {\n  return -amount;\n}\n`);
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'refund');
    const head = git('rev-parse', 'HEAD');
    assert.notEqual(head, indexedAtInit);

    cli(repo, ['ingest']);
    assert.equal(readMeta(path.join(repo.dir, '.memory')).lastCommit, head, 'a full ingest is this commit');
    assert.match(cli(repo, ['status']), /current/);

    // One more commit, then a scan of one path: the graph is not the whole tree.
    write(repo, 'src/billing.js', `${CALLER}\nexport function later() {\n  return 1;\n}\n`);
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'later');
    cli(repo, ['ingest', 'src/billing.js']);
    assert.equal(
      readMeta(path.join(repo.dir, '.memory')).lastCommit,
      head,
      'a scan of named paths must not claim the commit it did not fully read',
    );
  } finally {
    repo.cleanup();
  }
});
