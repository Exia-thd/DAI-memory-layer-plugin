/**
 * detect-changes and review over a repository whose diff is written by the test.
 *
 *   authRouter -> loginHandler -> validateUser -> checkPassword
 *   apiMiddleware -> validateUser, and apiMiddleware -> helper -> inner
 *
 * The fixture is committed, indexed, and then edited: a body change, a whole
 * declaration deleted, a brand new file, and a change in a file the index has
 * never seen. Each one has a different right answer, and the wrong answers --
 * matching new code against old line numbers, or reporting a removed
 * declaration as merely modified -- are what these check for.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, cli } from './helpers.js';

const FILES = {
  'src/auth/login.ts': [
    "import { validateUser } from './validate';",
    'export function loginHandler(req) {',
    '  return validateUser(req.user);',
    '}',
  ].join('\n'),
  'src/auth/validate.ts': [
    'export function validateUser(user) {',
    '  return checkPassword(user.password);',
    '}',
    'export function checkPassword(password) {',
    '  return password.length > 0;',
    '}',
  ].join('\n'),
  'src/api/middleware.ts': [
    "import { validateUser } from '../auth/validate';",
    "import { helper } from '../util/helper';",
    'export function apiMiddleware(req) {',
    '  return helper(validateUser(req.user));',
    '}',
  ].join('\n'),
  'src/routes/router.ts': [
    "import { loginHandler } from '../auth/login';",
    'export function authRouter(req) {',
    '  return loginHandler(req);',
    '}',
  ].join('\n'),
  // Three declarations in a fixed order. The edit inserts a block above them,
  // so every later line moves: the old and new sides of the diff disagree by
  // twenty lines, and only one of them lines up with the index.
  'src/shift/order.ts': [
    'export function alpha() {',
    '  return 1;',
    '}',
    'export function beta() {',
    '  return 2;',
    '}',
    'export function gamma() {',
    '  return 3;',
    '}',
  ].join('\n'),
  'src/util/helper.ts': [
    'export function helper(value) {',
    '  return inner(value);',
    '}',
    'export function inner(value) {',
    '  return value;',
    '}',
  ].join('\n'),
};

let repo;
const write = (relative, content) => {
  const full = path.join(repo.dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const git = (...args) => execFileSync('git', args, { cwd: repo.dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);

  // A body change inside checkPassword.
  write('src/auth/validate.ts', [
    'export function validateUser(user) {',
    '  return checkPassword(user.password);',
    '}',
    'export function checkPassword(password) {',
    '  // stricter now',
    '  return password.length > 8;',
    '}',
  ].join('\n'));

  // helper is deleted outright; inner stays.
  write('src/util/helper.ts', [
    'export function inner(value) {',
    '  return value;',
    '}',
  ].join('\n'));

  // Twenty lines added above alpha, and gamma's body changed. Read on the new
  // side, gamma's change lands at a line the committed file does not have.
  write('src/shift/order.ts', [
    ...Array.from({ length: 20 }, (_, i) => `// padding ${i}`),
    'export function alpha() {',
    '  return 1;',
    '}',
    'export function beta() {',
    '  return 2;',
    '}',
    'export function gamma() {',
    '  return 33;',
    '}',
  ].join('\n'));

  // A file the index has never seen.
  write('src/new/feature.ts', 'export function feature() {\n  return 1;\n}\n');
  git('add', '-A');
});

after(() => repo?.cleanup());

test('a diff is answered in declarations, with what depends on each', () => {
  const result = json(['detect-changes', '--scope', 'staged']);
  assert.equal(result.status, 'ok');
  const byName = Object.fromEntries(result.symbols.map((symbol) => [symbol.qualified, symbol]));

  const changed = byName.checkPassword;
  assert.ok(changed, JSON.stringify(result.symbols.map((symbol) => symbol.qualified)));
  assert.equal(changed.change, 'modified');
  assert.ok(changed.dependents.total >= 1, JSON.stringify(changed.dependents));
  assert.ok(changed.dependents.direct.some((ref) => ref.qualified === 'validateUser'));
  assert.ok(changed.processes.some((process) => process.name === 'authRouter'), JSON.stringify(changed.processes));
});

test('hunks are read on the side the graph was built from', () => {
  const result = json(['detect-changes', '--scope', 'staged']);
  const inFile = result.symbols
    .filter((symbol) => symbol.filePath === 'src/shift/order.ts')
    .map((symbol) => symbol.qualified);

  // gamma is what changed. Reading the new side instead would look for line 31
  // in a file that has nine lines, and find gamma's neighbours or nothing.
  assert.ok(inFile.includes('gamma'), `expected gamma, got ${JSON.stringify(inFile)}`);
  assert.ok(!inFile.includes('beta'), `beta did not change, got ${JSON.stringify(inFile)}`);
});

test('a declaration that is gone is reported as removed, not as changed', () => {
  const result = json(['detect-changes', '--scope', 'staged']);
  const helper = result.symbols.find((symbol) => symbol.qualified === 'helper');
  assert.ok(helper, JSON.stringify(result.symbols.map((symbol) => symbol.qualified)));
  assert.equal(helper.change, 'removed');
  assert.equal(result.summary.removed, 1);
});

test('code the index has not seen is counted and declared, never matched by line number', () => {
  const result = json(['detect-changes', '--scope', 'staged']);
  const fresh = result.files.find((file) => file.file === 'src/new/feature.ts');
  assert.ok(fresh, JSON.stringify(result.files.map((file) => file.file)));
  assert.equal(fresh.unindexed, true);
  assert.equal(fresh.symbols.length, 0);
  assert.ok(fresh.unmatchedHunks >= 1);
  assert.ok(result.limits.some((limit) => /not in the code graph/.test(limit)), JSON.stringify(result.limits));

  // No declaration may be attributed to the new file's line numbers.
  assert.ok(!result.symbols.some((symbol) => symbol.filePath === 'src/new/feature.ts'));
});

test('an answer built from an older commit says the graph is behind', () => {
  git('commit', '-qm', 'changes');
  const result = json(['detect-changes', '--scope', 'compare', '--base', 'HEAD~1']);
  assert.ok(
    result.limits.some((limit) => /code graph was built at/.test(limit)),
    JSON.stringify(result.limits),
  );
  assert.ok(result.symbols.length > 0, 'a compare against the previous commit still finds the change');
});

test('review separates what can break other files from what cannot', () => {
  const result = json(['review', '--base', 'HEAD~1']);
  assert.equal(result.status, 'ok');
  const breaking = Object.fromEntries(result.breaking.map((item) => [item.symbol.qualified, item]));

  // helper was removed while apiMiddleware still calls it: the case that
  // breaks a build rather than changing behaviour.
  assert.ok(breaking.helper, JSON.stringify(result.breaking.map((item) => item.symbol.qualified)));
  assert.match(breaking.helper.reason, /removed/);
  assert.ok(breaking.helper.dependents.some((ref) => ref.qualified === 'apiMiddleware'), JSON.stringify(breaking.helper.dependents));

  // checkPassword is called from its own file only, so changing it breaks
  // nothing outside -- it must not be listed as a cross-file break.
  assert.ok(!breaking.checkPassword || /removed/.test(breaking.checkPassword.reason));
});

test('review names the modules a change lands in', () => {
  const result = json(['review', '--base', 'HEAD~1']);
  const modules = result.modules.map((module) => module.module);
  assert.ok(modules.includes('src/auth'), JSON.stringify(result.modules));
  assert.ok(modules.includes('src/util'), JSON.stringify(result.modules));
});

test('reviewers come from history, and the answer says that is what they are', () => {
  const result = json(['review', '--base', 'HEAD~1']);
  assert.ok(result.reviewers.length > 0, JSON.stringify(result));
  assert.equal(result.reviewers[0].name, 'test');
  assert.match(result.summary.reviewersFrom, /not who should review/);
});

test('the text forms read the way the JSON does', () => {
  const text = cli(repo, ['detect-changes', '--scope', 'compare', '--base', 'HEAD~1']);
  assert.match(text, /compare changes: \d+ declaration\(s\) in \d+ file\(s\)/);
  assert.match(text, /REMOVED helper/);
  assert.match(text, /risk: (LOW|MEDIUM|HIGH|CRITICAL) --/);
  assert.match(cli(repo, ['review', '--base', 'HEAD~1']), /who has worked here:/);
});
