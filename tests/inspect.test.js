/**
 * check, code-clusters, cypher, status and clean.
 *
 * The fixture has an import cycle between two files, a declaration nothing
 * touches, a tight group of functions that call each other, and a file that
 * imports but declares nothing. Each of those is what one of these commands is
 * for, and the answers they must not give are the interesting half: a query
 * that writes, a clean that removes a store nobody confirmed, and an empty
 * check that cannot say what it looked at.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  // Two files that import each other.
  'src/cycle/a.ts': [
    "import { beta } from './b';",
    'export function alpha() {',
    '  return beta();',
    '}',
  ].join('\n'),
  'src/cycle/b.ts': [
    "import { alpha } from './a';",
    'export function beta() {',
    '  return 1;',
    '}',
    'export function gamma() {',
    '  return alpha();',
    '}',
  ].join('\n'),
  // A tight group: each calls the next.
  'src/pipeline/steps.ts': [
    'export function first(input) {',
    '  return second(input);',
    '}',
    'export function second(input) {',
    '  return third(input);',
    '}',
    'export function third(input) {',
    '  return fourth(input);',
    '}',
    'export function fourth(input) {',
    '  return input;',
    '}',
  ].join('\n'),
  // Nothing calls it and it calls nothing.
  'src/lonely/orphan.ts': 'export function orphan() {\n  return 1;\n}\n',
  // Imports, declares nothing indexed.
  'src/config/only-imports.ts': "import { orphan } from '../lonely/orphan';\n",
};

let repo;
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

test('check finds the import cycle and names the files in it', () => {
  const result = json(['check']);
  const cycle = result.findings.find((finding) => finding.rule === 'circular-imports');
  assert.ok(cycle, JSON.stringify(result.findings.map((finding) => finding.rule)));
  assert.equal(cycle.severity, 'warning');
  assert.ok(cycle.where.some((where) => where.includes('src/cycle/a.ts') && where.includes('src/cycle/b.ts')), JSON.stringify(cycle.where));
});

test('check reports what each rule examined, so an empty finding can be read', () => {
  const result = json(['check']);
  assert.ok(result.summary.examined['circular-imports'] > 0, JSON.stringify(result.summary));
  assert.ok(result.summary.examined['isolated-declarations'] > 0, JSON.stringify(result.summary));
  assert.match(cli(repo, ['check']), /what each rule looked at:/);
});

test('a declaration that takes part in nothing is reported as such', () => {
  const result = json(['check']);
  const isolated = result.findings.find((finding) => finding.rule === 'isolated-declarations');
  assert.ok(isolated, JSON.stringify(result.findings.map((finding) => finding.rule)));
  assert.ok(isolated.where.some((where) => where.includes('orphan')), JSON.stringify(isolated.where));
  // It is information, not a verdict: an exported function may have callers
  // this repository cannot see.
  assert.equal(isolated.severity, 'info');
  assert.match(isolated.message, /outside this repository/);
});

test('check exits zero unless failing was asked for', () => {
  assert.equal(cliRaw(repo, ['check', '--json']).status, 0);
  assert.equal(cliRaw(repo, ['check', '--fail-on', 'warning', '--json']).status, 1, 'the import cycle is a warning');
  assert.equal(cliRaw(repo, ['check', '--fail-on', 'error', '--json']).status, 0, 'there are no errors');
});

test('code clusters group what calls what, and are named after where it lives', () => {
  const result = json(['code-clusters', '--min-size', '2']);
  const pipeline = result.clusters.find((cluster) => cluster.files.includes('src/pipeline/steps.ts'));
  assert.ok(pipeline, JSON.stringify(result.clusters.map((cluster) => cluster.name)));
  assert.equal(pipeline.name, 'src/pipeline');
  const members = pipeline.members.map((member) => member.qualified);
  assert.ok(members.includes('first') || members.includes('second'), JSON.stringify(members));
  assert.match(result.summary.rule, /Louvain/);
});

test('cypher answers a read-only query, bounded', () => {
  const result = json(['cypher', 'MATCH (s:Symbol) RETURN s.name AS name', '--limit', '3']);
  assert.equal(result.status, 'ok');
  assert.ok(result.rows.length <= 3, JSON.stringify(result.rows));
  assert.match(result.query, /LIMIT 3$/, 'a query without a limit is given one');
  assert.ok(result.rows.every((row) => typeof row.name === 'string'), JSON.stringify(result.rows));
});

test('cypher refuses to write, to run two statements, and to return nothing', () => {
  const refusals = [
    ['MATCH (s:Symbol) SET s.name = "x" RETURN s', /read-only/],
    ['MATCH (s:Symbol) DETACH DELETE s RETURN 1', /read-only/],
    ['MATCH (s:Symbol) RETURN s; MATCH (m:Memory) RETURN m', /one statement at a time/],
    ['MATCH (s:Symbol)', /RETURN something/],
  ];
  for (const [query, reason] of refusals) {
    const result = cliRaw(repo, ['cypher', query, '--json']);
    assert.equal(result.status, 1, `${query} must not run`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'refused');
    assert.match(body.reason, reason);
  }

  // And the store is untouched: the declarations are still there under their
  // own names.
  const after = json(['cypher', 'MATCH (s:Symbol) WHERE s.name = "orphan" RETURN s.name AS name']);
  assert.equal(after.rows.length, 1, JSON.stringify(after));
});

test('status says what is indexed and whether that is still current', () => {
  const result = json(['status']);
  assert.equal(result.status, 'ok');
  assert.equal(result.index.stale, false);
  assert.equal(result.index.indexedCommit, result.project.head);
  assert.ok(result.graph.declarations > 0 && result.graph.files > 0, JSON.stringify(result.graph));
  assert.match(cli(repo, ['status']), /indexed at [0-9a-f]+ {2}-- current/);
});

test('clean removes nothing without being told to', () => {
  const storeDir = path.join(repo.dir, '.memory');
  const refused = cliRaw(repo, ['clean', '--json']);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).status, 'refused');
  assert.ok(fs.existsSync(storeDir), 'the store must still be there');

  const removed = JSON.parse(cli(repo, ['clean', '--yes', '--json']));
  assert.equal(removed.status, 'removed');
  assert.ok(!fs.existsSync(storeDir), 'the store was not removed');
});
