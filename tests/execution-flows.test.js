/**
 * Execution flows over a repository whose entry points are known.
 *
 *   authRouter -> loginHandler -> validateUser -> checkPassword -> hash
 *   apiMiddleware -> validateUser
 *   checkout -> BillingService.charge -> settle
 *   bootstrap -> new BillingService(), whose members run once it is built
 *   a test calls validateUser
 *   orphan() calls nothing and nothing calls it
 *   two files each declare a function called `render`
 *
 * authRouter, apiMiddleware and checkout are entry points: nothing calls them
 * and they call something. hash and orphan are not: hash is called, and orphan
 * calls nothing. Every claim below is checked against that picture, including
 * the ones that are refusals: a flow name that fits two flows, and one that
 * fits none.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  'src/auth/login.ts': [
    "import { validateUser } from './validate';",
    'export function loginHandler(req) {',
    '  return validateUser(req.user);',
    '}',
  ].join('\n'),
  'src/auth/validate.ts': [
    "import { hash } from '../crypto/hash';",
    'export function validateUser(user) {',
    '  return checkPassword(user.password);',
    '}',
    'export function checkPassword(password) {',
    '  return hash(password);',
    '}',
  ].join('\n'),
  'src/crypto/hash.ts': 'export function hash(value) {\n  return value;\n}\n',
  'src/api/middleware.ts': [
    "import { validateUser } from '../auth/validate';",
    'export function apiMiddleware(req) {',
    '  return validateUser(req.user);',
    '}',
  ].join('\n'),
  'src/routes/router.ts': [
    "import { loginHandler } from '../auth/login';",
    'export function authRouter(req) {',
    '  return loginHandler(req);',
    '}',
  ].join('\n'),
  'tests/validate.test.ts': [
    "import { validateUser } from '../src/auth/validate';",
    'export function testValidateUser() {',
    '  return validateUser({ password: "x" });',
    '}',
  ].join('\n'),
  'src/billing/service.ts': [
    'export class BillingService {',
    '  charge(amount) {',
    '    return settle(amount);',
    '  }',
    '}',
    'export function settle(amount) {',
    '  return amount;',
    '}',
  ].join('\n'),
  'src/shop/checkout.ts': [
    "import { BillingService } from '../billing/service';",
    'export function checkout(service: BillingService) {',
    '  return service.charge(1);',
    '}',
  ].join('\n'),
  'src/boot/start.ts': [
    "import { BillingService } from '../billing/service';",
    'export function bootstrap() {',
    '  const service = new BillingService();',
    '  return service;',
    '}',
  ].join('\n'),
  'src/dead/orphan.ts': 'export function orphan() {\n  return 1;\n}\n',
  'src/web/page.ts': [
    "import { hash } from '../crypto/hash';",
    'export function render(model) {',
    '  return hash(model);',
    '}',
  ].join('\n'),
  'src/mail/page.ts': [
    "import { hash } from '../crypto/hash';",
    'export function render(message) {',
    '  return hash(message);',
    '}',
  ].join('\n'),
};

let repo;

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

const json = (args) => JSON.parse(cli(repo, [...args, '--json']));
const names = (list = []) => list.map((item) => item.name ?? item.qualified).sort();

test('an entry point is what nothing calls and what calls something', () => {
  const result = json(['processes']);
  assert.equal(result.status, 'ok');
  const found = names(result.processes);
  assert.ok(found.includes('authRouter'), found);
  assert.ok(found.includes('apiMiddleware'), found);
  assert.ok(found.includes('checkout'), found);

  // Anything with a caller is a step in someone else's flow, never a start.
  for (const called of ['loginHandler', 'validateUser', 'checkPassword', 'hash', 'settle']) {
    assert.ok(!found.includes(called), `${called} has callers and must not start a flow: ${found}`);
  }
  // orphan calls nothing: there is no flow to describe.
  assert.ok(!found.includes('orphan'), found);
  // A test calling production code does not make a flow.
  assert.ok(!found.includes('testValidateUser'), found);
  // The rule is reported, not left for the reader to infer.
  assert.match(result.summary.rule, /nothing in this repository calls/);
});

test('a flow is the entry point and what it reaches, by distance', () => {
  const flow = json(['process', 'authRouter']);
  assert.equal(flow.status, 'ok');
  assert.equal(flow.entry.qualified, 'authRouter');
  const byDepth = {};
  for (const step of flow.steps) (byDepth[step.depth] ??= []).push(step.qualified);
  assert.deepEqual(byDepth[1], ['loginHandler']);
  assert.deepEqual(byDepth[2], ['validateUser']);
  assert.deepEqual(byDepth[3], ['checkPassword']);
  assert.deepEqual(byDepth[4], ['hash']);
  assert.equal(flow.truncated, false);
  for (const step of flow.steps) {
    assert.ok(step.confidence > 0 && step.confidence <= 1, JSON.stringify(step));
    assert.ok(step.pathConfidence <= step.confidence);
  }
});

test('building a type puts its members in the flow, and they carry it on', () => {
  // bootstrap only constructs BillingService. What runs next is inside the
  // type, so a flow that stopped at the class would describe nothing.
  const flow = json(['process', 'bootstrap']);
  const steps = flow.steps.map((step) => `${step.qualified}/${step.via}`);
  assert.ok(steps.includes('BillingService/CALLS'), steps);
  assert.ok(steps.includes('BillingService.charge/MEMBER'), steps);
  assert.ok(steps.includes('settle/CALLS'), steps);

  // Reached directly, the member is a plain call.
  const direct = json(['process', 'checkout']).steps.map((step) => `${step.qualified}/${step.via}`);
  assert.ok(direct.includes('BillingService.charge/CALLS'), direct);
});

test('a flow name that fits two flows is answered with both, and exits non-zero', () => {
  const result = cliRaw(repo, ['process', 'render', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'ambiguous');
  assert.deepEqual(body.candidates.map((item) => item.filePath).sort(), ['src/mail/page.ts', 'src/web/page.ts']);
  // And either one can then be asked for exactly, by its id.
  const id = body.candidates.find((item) => item.filePath === 'src/mail/page.ts').id;
  assert.equal(json(['process', id]).entry.filePath, 'src/mail/page.ts');
});

test('a name that is a declaration inside a flow says which flows run it', () => {
  const result = cliRaw(repo, ['process', 'checkPassword', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'not_found');
  assert.ok(names(body.suggestions).includes('authRouter'), JSON.stringify(body.suggestions));
});

test('impact says which flows run through a change, and can be asked not to look', () => {
  const result = json(['impact', 'validateUser']);
  assert.equal(result.processes.status, 'ok');
  assert.ok(names(result.processes.items).includes('authRouter'), JSON.stringify(result.processes.items));
  assert.ok(names(result.processes.items).includes('apiMiddleware'));
  // checkout reaches none of this, so it is not listed.
  assert.ok(!names(result.processes.items).includes('checkout'));

  const off = json(['impact', 'validateUser', '--no-flows']);
  assert.equal(off.processes.status, 'not_computed');
  assert.match(off.processes.note, /not the same as none being affected/);
});

test('a change nothing runs says so, rather than listing nothing', () => {
  const result = json(['impact', 'orphan']);
  assert.equal(result.processes.status, 'ok');
  assert.deepEqual(result.processes.items, []);
  assert.match(result.processes.note, /No execution flow/);
});

test('context places a declaration in the flows it takes part in', () => {
  const result = json(['context', 'checkPassword']);
  assert.equal(result.processes.status, 'ok');
  const authRouter = result.processes.items.find((item) => item.name === 'authRouter');
  assert.ok(authRouter, JSON.stringify(result.processes.items));
  assert.equal(authRouter.depth, 3, 'three calls from the entry point');
});

test('query answers with flows, not a list of files', () => {
  const result = json(['query', 'validate user']);
  assert.equal(result.status, 'ok');
  const flows = result.groups.filter((group) => group.process !== null).map((group) => group.process.name);
  assert.ok(flows.includes('authRouter'), JSON.stringify(flows));
  const hit = result.groups.flatMap((group) => group.hits).find((item) => item.qualified === 'validateUser');
  assert.ok(hit && hit.score > 0, JSON.stringify(result.groups));
  assert.ok(result.summary.testsSkipped >= 1);
});

test('a match no flow reaches is returned in its own group, not dropped', () => {
  const result = json(['query', 'orphan']);
  const loose = result.groups.find((group) => group.process === null);
  assert.ok(loose, JSON.stringify(result.groups));
  assert.ok(loose.hits.some((hit) => hit.qualified === 'orphan'));
  assert.equal(result.summary.unassigned, loose.hits.length);
});

test('query carries the memory recorded about what it found', () => {
  const written = JSON.parse(cli(repo, [
    'write', '--layer', 'semantic', '--title', 'Passwords are checked before sessions open',
    '--body', 'Chosen so a locked account never gets a token.',
    '--source-ref', 'src/auth/validate.ts#L2-L4', '--json',
  ]));
  const result = json(['query', 'validate user']);
  const recorded = result.groups.flatMap((group) => group.memories.map((memory) => memory.id));
  assert.ok(recorded.includes(written.id), JSON.stringify(result.groups.map((group) => group.memories)));
});

test('words that match nothing are an empty answer that says so', () => {
  const result = json(['query', 'quantum teleportation']);
  assert.deepEqual(result.groups, []);
  assert.equal(result.summary.symbols, 0);
  assert.match(cli(repo, ['query', 'quantum teleportation']), /nothing in the code graph matches/);
});

test('the text forms read the way the JSON does', () => {
  assert.match(cli(repo, ['processes']), /execution flow\(s\) from \d+ entry point\(s\)/);
  assert.match(cli(repo, ['process', 'authRouter']), /d=1:\n\s+loginHandler {2}src\/auth\/login\.ts:\d+ {2}\[CALLS, \d+%\]/);
  assert.match(cli(repo, ['context', 'checkPassword']), /execution flows: It takes part in \d+ execution flow\(s\)\./);
  assert.match(cli(repo, ['query', 'validate user']), /flow: \w+ {2}src\//);
});
