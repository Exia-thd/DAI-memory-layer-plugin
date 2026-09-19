/**
 * rename, over a repository built so that find-and-replace would get it wrong.
 *
 *   validateUser is called from two files
 *   a comment and a string literal both mention validateUser
 *   an unrelated file declares its own validateUser, with its own caller
 *   BillingService is extended by PremiumBilling
 *
 * The right answer rewrites the declaration and the two real calls, leaves the
 * other file's validateUser alone, and reports the comment, the string and the
 * stranger separately instead of quietly changing them. A dry run must write
 * nothing at all, and a rename against an index older than the files must
 * refuse rather than write positions that have moved.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  'src/auth/validate.ts': [
    'export function validateUser(user) {',
    '  return Boolean(user);',
    '}',
  ].join('\n'),
  'src/auth/login.ts': [
    "import { validateUser } from './validate';",
    '// validateUser decides whether a session may open',
    'export function loginHandler(req) {',
    '  return validateUser(req.user);',
    '}',
  ].join('\n'),
  'src/api/middleware.ts': [
    "import { validateUser } from '../auth/validate';",
    'export function apiMiddleware(req) {',
    '  const step = "validateUser";',
    '  return validateUser(req.user) && step.length > 0;',
    '}',
  ].join('\n'),
  'src/legacy/other.ts': [
    'export function validateUser(payload) {',
    '  return payload !== null;',
    '}',
    'export function legacyEntry(payload) {',
    '  return validateUser(payload);',
    '}',
  ].join('\n'),
  'src/billing/service.ts': [
    'export class BillingService {',
    '  charge(amount) {',
    '    return amount;',
    '  }',
    '}',
    'export class PremiumBilling extends BillingService {',
    '}',
  ].join('\n'),
};

let repo;
const read = (relative) => fs.readFileSync(path.join(repo.dir, relative), 'utf8');
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

test('a plan covers the declaration and the calls the graph resolved, and nothing else', () => {
  const plan = json(['rename', 'validateUser', 'checkUser', '--file', 'auth/validate.ts']);
  assert.equal(plan.status, 'ok');
  const sites = plan.edits.map((edit) => `${edit.file}:${edit.line}`);
  assert.ok(sites.includes('src/auth/validate.ts:1'), JSON.stringify(sites));
  assert.ok(sites.some((site) => site.startsWith('src/auth/login.ts:')), JSON.stringify(sites));
  assert.ok(sites.some((site) => site.startsWith('src/api/middleware.ts:')), JSON.stringify(sites));

  // The other declaration and its caller are a different function.
  assert.ok(!sites.some((site) => site.startsWith('src/legacy/other.ts:')), JSON.stringify(sites));
  for (const edit of plan.edits) {
    assert.equal(edit.before, 'validateUser');
    assert.ok(edit.confidence > 0 && edit.confidence <= 1, JSON.stringify(edit));
  }
});

test('the word elsewhere is reported, not rewritten', () => {
  const plan = json(['rename', 'validateUser', 'checkUser', '--file', 'auth/validate.ts']);
  const elsewhere = plan.textOnly.map((match) => `${match.file}:${match.line}`);

  // The comment, the string literal, the import lines and the other
  // declaration all mention the word; none of them is an edit.
  assert.ok(elsewhere.includes('src/auth/login.ts:2'), `the comment: ${JSON.stringify(elsewhere)}`);
  assert.ok(elsewhere.includes('src/api/middleware.ts:3'), `the string: ${JSON.stringify(elsewhere)}`);
  assert.ok(elsewhere.some((site) => site.startsWith('src/legacy/other.ts:')), JSON.stringify(elsewhere));
  assert.ok(plan.limits.some((limit) => /not part of this rename/.test(limit)), JSON.stringify(plan.limits));
  assert.ok(plan.summary.textOnly >= 4, JSON.stringify(plan.summary));
});

test('a plan writes nothing', () => {
  const before = read('src/auth/validate.ts');
  const plan = json(['rename', 'validateUser', 'checkUser', '--file', 'auth/validate.ts']);
  assert.equal(plan.applied, null);
  assert.equal(read('src/auth/validate.ts'), before);
  assert.match(cli(repo, ['rename', 'validateUser', 'checkUser', '--file', 'auth/validate.ts']), /nothing was written/);
});

test('a name that fits two declarations is refused, and exits non-zero', () => {
  const result = cliRaw(repo, ['rename', 'validateUser', 'checkUser', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'ambiguous');
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.filePath).sort(),
    ['src/auth/validate.ts', 'src/legacy/other.ts'],
  );
});

test('a name that is not an identifier, or is already taken here, is refused', () => {
  const bad = cliRaw(repo, ['rename', 'validateUser', '2fast', '--file', 'auth/validate.ts', '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).status, 'invalid_name');

  const taken = cliRaw(repo, ['rename', 'BillingService', 'PremiumBilling', '--json']);
  assert.equal(taken.status, 1);
  const body = JSON.parse(taken.stdout);
  assert.equal(body.status, 'occupied');
  assert.equal(body.conflicts[0].filePath, 'src/billing/service.ts');
});

test('--apply rewrites exactly the planned sites', () => {
  const applied = json(['rename', 'validateUser', 'checkUser', '--file', 'auth/validate.ts', '--apply']);
  assert.equal(applied.status, 'ok');
  assert.ok(applied.applied.edits >= 3, JSON.stringify(applied.applied));
  assert.equal(applied.applied.skipped, 0);

  assert.match(read('src/auth/validate.ts'), /export function checkUser\(user\)/);
  assert.match(read('src/auth/login.ts'), /return checkUser\(req\.user\)/);
  assert.match(read('src/api/middleware.ts'), /return checkUser\(req\.user\)/);

  // What was reported as text stayed as it was.
  assert.match(read('src/auth/login.ts'), /\/\/ validateUser decides/);
  assert.match(read('src/api/middleware.ts'), /const step = "validateUser"/);
  assert.match(read('src/legacy/other.ts'), /export function validateUser\(payload\)/);
  assert.match(read('src/legacy/other.ts'), /return validateUser\(payload\)/);
});

test('a type keeps its members, and the types deriving from it are updated', () => {
  const plan = json(['rename', 'BillingService', 'PaymentService', '--apply']);
  assert.equal(plan.status, 'ok');
  const text = read('src/billing/service.ts');
  assert.match(text, /export class PaymentService \{/);
  assert.match(text, /class PremiumBilling extends PaymentService/);
  // The member is not renamed: charge is its own declaration.
  assert.match(text, /charge\(amount\)/);
});

test('an index older than the files refuses to rename anything', () => {
  const before = read('src/auth/validate.ts');
  fs.appendFileSync(path.join(repo.dir, 'src/auth/validate.ts'), '\nexport function extra() {\n  return 1;\n}\n');
  execFileSync('git', ['-C', repo.dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo.dir, 'commit', '-qm', 'move on'], { stdio: 'ignore' });

  const result = cliRaw(repo, ['rename', 'checkUser', 'verifyUser', '--file', 'auth/validate.ts', '--apply', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'stale');
  assert.match(body.reason, /older than the working tree/);
  assert.ok(read('src/auth/validate.ts').startsWith(before.split('\n')[0]), 'the file must not have been touched');
  const text = cliRaw(repo, ['rename', 'checkUser', 'verifyUser', '--file', 'auth/validate.ts']);
  assert.equal(text.status, 1, 'a refusal exits non-zero');
  assert.match(text.stdout, /refusing to rename/);
});

/**
 * The apply step checks every position against the file before it writes.
 *
 * Through the CLI, planning and applying read the same text in one process, so
 * the check cannot fire there. It exists for a caller that holds a plan while
 * the files move -- an editor, or a second process -- and this exercises that
 * path directly, because a rename that writes into a changed file is the one
 * failure that loses somebody's work.
 */
test('applying a plan to a file that has changed skips rather than writes', async () => {
  const { planRename, applyRename } = await import('@memory-layer/core');

  const symbol = {
    id: 'Symbol:src/a.ts:target', name: 'target', filePath: 'src/a.ts',
    kind: 'function_declaration', startLine: 1, endLine: 3,
  };
  const index = {
    symbols: new Map([[symbol.id, symbol]]),
    callsOut: new Map(), callsIn: new Map(), inheritsOut: new Map(), inheritsIn: new Map(),
    importsOut: new Map(), importsIn: new Map(), parent: new Map(), children: new Map(),
    byName: new Map([['target', [symbol.id]]]),
  };

  const original = 'function target() {\n  return 1;\n}\n';
  const plan = planRename(index, symbol.id, 'renamed', { read: () => original });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.edits.length, 1);

  // The same plan, against a file whose first line is now something else.
  const moved = '// a line arrived above it\nfunction target() {\n  return 1;\n}\n';
  const { files, skipped } = applyRename(plan, () => moved);
  assert.deepEqual(files, [], 'nothing may be written when the position does not hold the old name');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /expected "target" at this position/);

  // And against the text it was planned from, it still applies.
  const good = applyRename(plan, () => original);
  assert.equal(good.skipped.length, 0);
  assert.match(good.files[0].text, /function renamed\(\)/);
});
