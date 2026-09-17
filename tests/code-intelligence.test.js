/**
 * impact, context and trace over a repository whose call chains are known.
 *
 *   authRouter -> loginHandler -> validateUser -> checkPassword -> hash
 *   apiMiddleware -> validateUser
 *   a test calls validateUser
 *   checkout(service: BillingService) -> service.charge -> settle
 *   PremiumBilling extends BillingService
 *   two unrelated functions are both called `validate`
 *
 * Every answer below is checked against that picture, including the ones that
 * are not answers: a name that fits two declarations, a name that fits none,
 * and a path that does not exist.
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
    'export class PremiumBilling extends BillingService {',
    '}',
  ].join('\n'),
  'src/shop/checkout.ts': [
    "import { BillingService } from '../billing/service';",
    'export function checkout(service: BillingService) {',
    '  return service.charge(1);',
    '}',
  ].join('\n'),
  'src/forms/validate.ts': 'export function validate(form) {\n  return form;\n}\n',
  'src/orders/validate.ts': 'export function validate(order) {\n  return order;\n}\n',
};

let repo;

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

const json = (args) => JSON.parse(cli(repo, [...args, '--json']));
const names = (hits = []) => hits.map((hit) => hit.qualified).sort();

test('upstream impact lists dependents by distance, and leaves tests out', () => {
  const result = json(['impact', 'validateUser']);
  assert.equal(result.status, 'ok');
  assert.deepEqual(names(result.byDepth[1]), ['apiMiddleware', 'loginHandler']);
  assert.deepEqual(names(result.byDepth[2]), ['authRouter']);
  assert.equal(result.labels[1], 'WILL BREAK');
  assert.equal(result.labels[2], 'LIKELY AFFECTED');
  assert.equal(result.summary.testsSkipped, 1, 'the test caller was not counted as left out');
  assert.ok(!JSON.stringify(result.byDepth).includes('testValidateUser'));

  const withTests = json(['impact', 'validateUser', '--include-tests']);
  assert.ok(names(withTests.byDepth[1]).includes('testValidateUser'));
});

test('depth genuinely limits the walk', () => {
  const three = json(['impact', 'hash']);
  assert.deepEqual(names(three.byDepth[1]), ['checkPassword']);
  assert.deepEqual(names(three.byDepth[2]), ['validateUser']);
  assert.deepEqual(names(three.byDepth[3]), ['apiMiddleware', 'loginHandler']);
  assert.equal(three.byDepth[4], undefined);

  const four = json(['impact', 'hash', '--depth', '4']);
  assert.deepEqual(names(four.byDepth[4]), ['authRouter']);

  const one = json(['impact', 'hash', '--depth', '1']);
  assert.deepEqual(Object.keys(one.byDepth), ['1']);
});

test('downstream impact is what the declaration depends on', () => {
  const result = json(['impact', 'loginHandler', '--direction', 'downstream']);
  assert.deepEqual(names(result.byDepth[1]), ['validateUser']);
  assert.deepEqual(names(result.byDepth[2]), ['checkPassword']);
  assert.deepEqual(names(result.byDepth[3]), ['hash']);
});

test('a type is reached through its members and its subclasses', () => {
  const result = json(['impact', 'BillingService']);
  const d1 = Object.fromEntries(result.byDepth[1].map((hit) => [hit.qualified, hit.via]));
  assert.equal(d1.checkout, 'MEMBER', 'calling a member is using the type');
  assert.equal(d1.PremiumBilling, 'INHERITS');
});

test('the risk level says what set it', () => {
  const auth = json(['impact', 'validateUser']);
  assert.equal(auth.summary.risk, 'CRITICAL');
  assert.ok(auth.summary.reasons.some((reason) => /critical path/.test(reason)), auth.summary.reasons);

  // A billing path is critical however few callers it has.
  const billing = json(['impact', 'settle', '--depth', '1']);
  assert.equal(billing.summary.risk, 'CRITICAL');

  // Somewhere nothing depends on and nothing is sensitive is low, and says why.
  const plain = json(['impact', 'validate', '--file', 'forms/validate.ts']);
  assert.equal(plain.summary.risk, 'LOW');
  assert.ok(plain.summary.reasons[0].startsWith('0 dependent'), plain.summary.reasons);
});

test('a confidence floor counts what it drops instead of hiding it', () => {
  const result = json(['impact', 'validateUser', '--min-confidence', '1.01']);
  assert.deepEqual(result.byDepth, {});
  assert.ok(result.summary.belowConfidence >= 2, JSON.stringify(result.summary));
  for (const hit of json(['impact', 'validateUser']).byDepth[1]) {
    assert.ok(hit.confidence > 0 && hit.confidence <= 1, JSON.stringify(hit));
    assert.ok(hit.pathConfidence <= hit.confidence);
  }
});

test('files that import the target are listed with it', () => {
  const result = json(['impact', 'validateUser']);
  assert.deepEqual(result.files.map((file) => file.path), ['src/api/middleware.ts', 'src/auth/login.ts']);
});

test('execution flows are declared missing, not returned empty', () => {
  const result = json(['impact', 'validateUser']);
  assert.equal(result.processes.status, 'not_computed');
});

test('a name that fits two declarations is answered with both, ranked, and exits non-zero', () => {
  const result = cliRaw(repo, ['impact', 'validate', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'ambiguous');
  assert.deepEqual(body.candidates.map((c) => c.filePath).sort(), ['src/forms/validate.ts', 'src/orders/validate.ts']);

  // And either one can then be asked for exactly.
  const uid = body.candidates.find((c) => c.filePath === 'src/orders/validate.ts').id.slice('Symbol:'.length);
  assert.equal(json(['impact', '--uid', uid]).target.filePath, 'src/orders/validate.ts');
  assert.equal(json(['impact', 'validate', '--file', 'forms/validate.ts']).target.filePath, 'src/forms/validate.ts');
});

test('a name that fits nothing says so, with the closest names', () => {
  const result = cliRaw(repo, ['impact', 'validat', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'not_found');
  assert.ok(body.suggestions.some((ref) => ref.name.startsWith('validat')), JSON.stringify(body.suggestions));
});

test('context shows a declaration from every side', () => {
  const result = json(['context', 'validateUser']);
  assert.equal(result.status, 'ok');
  assert.deepEqual(names(result.callers), ['apiMiddleware', 'loginHandler', 'testValidateUser']);
  assert.deepEqual(names(result.callees), ['checkPassword']);
  assert.deepEqual(result.file.importedBy, ['src/api/middleware.ts', 'src/auth/login.ts', 'tests/validate.test.ts']);
  assert.deepEqual(result.file.imports, ['src/crypto/hash.ts']);

  const type = json(['context', 'BillingService']);
  assert.deepEqual(names(type.members), ['BillingService.charge']);
  assert.deepEqual(names(type.derived), ['PremiumBilling']);

  const member = json(['context', 'BillingService.charge']);
  assert.equal(member.container.qualified, 'BillingService');
  assert.deepEqual(names(member.callers), ['checkout']);
});

test('context carries the memory recorded about the declaration', () => {
  const written = JSON.parse(cli(repo, [
    'write', '--layer', 'semantic', '--title', 'Passwords are checked before sessions open',
    '--body', 'Chosen so a locked account never gets a token.',
    '--source-ref', 'src/auth/validate.ts#L2-L4', '--json',
  ]));
  const result = json(['context', 'validateUser']);
  assert.ok(result.memories.some((memory) => memory.id === written.id), JSON.stringify(result.memories));
});

test('trace finds the shortest call path, entering types through members', () => {
  const chain = json(['trace', 'authRouter', 'hash']);
  assert.equal(chain.status, 'ok');
  assert.deepEqual(chain.hops.map((hop) => hop.qualified), ['authRouter', 'loginHandler', 'validateUser', 'checkPassword', 'hash']);
  assert.equal(chain.edges.length, 4);
  assert.ok(chain.edges.every((edge) => edge.relType === 'CALLS'));

  const viaMember = json(['trace', 'BillingService', 'settle']);
  assert.deepEqual(viaMember.hops.map((hop) => hop.qualified), ['BillingService', 'BillingService.charge', 'settle']);
  assert.deepEqual(viaMember.edges.map((edge) => edge.relType), ['HAS_MEMBER', 'CALLS']);
});

test('no path is an answer that says where the chain breaks', () => {
  const result = cliRaw(repo, ['trace', 'checkPassword', 'authRouter', '--json']);
  assert.equal(result.status, 0, 'no path is not a failure');
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'no_path');
  assert.equal(body.furthest.qualified, 'hash');
  assert.equal(body.truncated, false);

  const cut = JSON.parse(cli(repo, ['trace', 'authRouter', 'hash', '--depth', '2', '--json']));
  assert.equal(cut.status, 'no_path');
  assert.equal(cut.truncated, true, 'a search stopped by its depth limit has to say so');
});

test('the text forms read the way the JSON does', () => {
  const text = cli(repo, ['impact', 'validateUser']);
  assert.match(text, /d=1 \(WILL BREAK\):/);
  assert.match(text, /loginHandler {2}src\/auth\/login\.ts:\d+ {2}\[CALLS, \d+%\]/);
  assert.match(text, /risk: CRITICAL/);
  assert.match(cli(repo, ['trace', 'authRouter', 'hash']), /4 step\(s\) from authRouter to hash/);
  assert.match(cli(repo, ['context', 'validateUser']), /called by \(3\):/);
});
