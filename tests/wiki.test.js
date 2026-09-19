/**
 * The generated wiki.
 *
 * Its whole claim is that every sentence is derived: from the graph, from the
 * source, or copied from what a person recorded. So these check the content is
 * there, that a recorded decision arrives **verbatim** rather than rewritten,
 * that each page says where it came from and that no model wrote it, and that
 * --check reports drift without writing -- because a documentation command
 * that quietly rewrites the tree it is checking is a gate that cannot fail.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  'src/http/server.ts': [
    "import { chargeCard } from '../billing/charge';",
    'export function mountRoutes(app) {',
    "  app.post('/charges', (req, res) => res.json(chargeCard(req.body.amount)));",
    '}',
  ].join('\n'),
  'src/billing/charge.ts': [
    'export function chargeCard(amount) {',
    '  return { amount, status: "ok" };',
    '}',
  ].join('\n'),
  'src/cycle/a.ts': ["import { beta } from './b';", 'export function alpha() {', '  return beta();', '}'].join('\n'),
  'src/cycle/b.ts': ["import { alpha } from './a';", 'export function beta() {', '  return 1;', '}',
    'export function gamma() {', '  return alpha();', '}'].join('\n'),
};

const DECISION = 'Chosen over exponential backoff because the processor counts attempts, not elapsed time.';

let repo;
let wikiDir;
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));
const page = (name) => fs.readFileSync(path.join(wikiDir, name), 'utf8');

before(() => {
  repo = makeRepo(FILES);
  wikiDir = path.join(repo.dir, 'generated-wiki');
  cli(repo, ['init']);
  cli(repo, [
    'write', '--layer', 'semantic', '--title', 'Cap declined-card retries at two',
    '--body', DECISION, '--source-ref', 'src/billing/charge.ts#L1-L3', '--importance', '9',
  ]);
  cli(repo, ['wiki', '--out', wikiDir]);
});

after(() => repo?.cleanup());

test('the pages are written, and each says what it was derived from', () => {
  for (const name of ['index.md', 'flows.md', 'routes.md', 'areas.md', 'decisions.md', 'checks.md']) {
    assert.ok(fs.existsSync(path.join(wikiDir, name)), `${name} is missing`);
    assert.match(page(name), /Generated from .+ at commit/);
  }
});

test('every page states that no model wrote it', () => {
  for (const name of ['index.md', 'flows.md', 'decisions.md']) {
    assert.match(page(name), /No prose here was written by a language model/);
  }
  const result = json(['wiki', '--out', wikiDir, '--check']);
  assert.match(result.summary.prose, /no language model was called/);
});

test('a recorded decision is copied, not rewritten', () => {
  const decisions = page('decisions.md');
  assert.match(decisions, /Cap declined-card retries at two/);
  // The exact sentence, not a summary of it.
  assert.ok(decisions.includes(DECISION), 'the recorded body must appear verbatim');
  assert.match(decisions, /This page is a copy, not a summary/);
});

test('the flows, routes and checks pages hold what the commands find', () => {
  assert.match(page('flows.md'), /## mountRoutes/);
  assert.match(page('flows.md'), /chargeCard/);
  assert.match(page('routes.md'), /POST \| `\/charges`/);
  assert.match(page('checks.md'), /circular-imports/);
  assert.match(page('checks.md'), /src\/cycle\/a\.ts/);
});

test('a page that cannot be filled says why rather than looking empty', () => {
  const bare = makeRepo({ 'src/plain/one.ts': 'export function one() {\n  return 1;\n}\n' });
  try {
    cli(bare, ['init']);
    const out = path.join(bare.dir, 'wiki');
    cli(bare, ['wiki', '--out', out]);
    const routes = fs.readFileSync(path.join(out, 'routes.md'), 'utf8');
    assert.match(routes, /No route was found/);
    assert.match(routes, /not the same as this repository having no endpoints/);
  } finally {
    bare.cleanup();
  }
});

test('--check reports drift and writes nothing', () => {
  const before = page('index.md');
  const clean = json(['wiki', '--out', wikiDir, '--check']);
  assert.equal(clean.written.length, 0);
  assert.equal(clean.summary.changed, 0, JSON.stringify(clean.drift));
  assert.equal(clean.summary.missing, 0);

  fs.writeFileSync(path.join(wikiDir, 'index.md'), '# edited by hand\n');
  const drifted = cliRaw(repo, ['wiki', '--out', wikiDir, '--check', '--json']);
  assert.equal(drifted.status, 1, 'drift is a failure when it was asked as a question');
  const body = JSON.parse(drifted.stdout);
  assert.equal(body.summary.changed, 1, JSON.stringify(body.drift));
  assert.equal(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), '# edited by hand\n',
    '--check must not repair what it is checking');

  // Writing puts it back.
  cli(repo, ['wiki', '--out', wikiDir]);
  assert.equal(page('index.md').split('\n---\n')[0], before.split('\n---\n')[0]);
});

test('a file in the directory that is not generated is reported, not deleted', () => {
  const extra = path.join(wikiDir, 'notes.md');
  fs.writeFileSync(extra, '# my own notes\n');
  const result = json(['wiki', '--out', wikiDir, '--check']);
  const found = result.drift.find((entry) => entry.path === 'notes.md');
  assert.ok(found, JSON.stringify(result.drift));
  assert.equal(found.state, 'extra');

  cli(repo, ['wiki', '--out', wikiDir]);
  assert.ok(fs.existsSync(extra), 'a file it did not write must survive a write');
});

test('the text form reads the way the JSON does', () => {
  const text = cli(repo, ['wiki', '--out', wikiDir]);
  assert.match(text, /page\(s\) in /);
  assert.match(text, /prose: derived from the repository/);
});
