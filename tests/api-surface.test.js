/**
 * routes, shape-check, api-impact and tools.
 *
 * The fixture declares the same idea in four frameworks -- Express, FastAPI,
 * Flask and a NestJS-style decorator -- plus one route whose path is a
 * variable, one path declared twice, one path parameter the handler ignores,
 * and an MCP tool. Each of those has an answer that must not be a guess: the
 * runtime path is reported as unknown rather than invented, and the frameworks
 * looked for are part of the answer so an empty list cannot be read as "this
 * service has no endpoints".
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  'src/http/express.ts': [
    "import { getUser } from '../service/users';",
    'export function mountUsers(app) {',
    "  app.get('/users/:id', (req, res) => res.json(getUser(req.params.id)));",
    "  app.post('/users', (req, res) => res.json({}));",
    '}',
  ].join('\n'),
  'src/http/duplicate.ts': [
    'export function mountAgain(app) {',
    "  app.post('/users', (req, res) => res.json({ again: true }));",
    '}',
  ].join('\n'),
  'src/http/dynamic.ts': [
    'export function mountDynamic(app, prefix) {',
    '  app.get(prefix, (req, res) => res.json({}));',
    '}',
  ].join('\n'),
  'src/http/api.py': [
    '@app.get("/health")',
    'def health():',
    '    return {"ok": True}',
    '',
    '@app.route("/legacy", methods=["POST"])',
    'def legacy():',
    '    return "legacy"',
  ].join('\n'),
  'src/http/orders.ts': [
    '@Get("/orders/:orderId")',
    'export function listOrders() {',
    '  return [];',
    '}',
  ].join('\n'),
  'src/service/users.ts': [
    "import { findUser } from './store';",
    'export function getUser(id) {',
    '  return findUser(id);',
    '}',
  ].join('\n'),
  'src/service/store.ts': [
    'export function findUser(id) {',
    '  return { id };',
    '}',
  ].join('\n'),
  // Nothing routes to this one: it is the case where "no endpoints" is the
  // true answer rather than a pattern having missed something.
  'src/service/offline.ts': [
    "import { findUser } from './store';",
    'export function nightlyJob() {',
    '  return findUser("batch");',
    '}',
  ].join('\n'),
  'src/mcp/server.ts': [
    'export const TOOLS = [',
    '  {',
    "    name: 'do_the_thing',",
    "    description: 'Does the thing it says.',",
    "    inputSchema: { type: 'object', properties: {} },",
    '  },',
    '];',
    '',
    '// An object with a name and no input schema is not a tool. Plenty of code',
    '// has one; treating it as a tool is how a tool map fills with nonsense.',
    'export const SERVER = {',
    "  name: 'not_a_tool',",
    "  version: '1.0.0',",
    '};',
  ].join('\n'),
};

let repo;
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

test('routes are found across frameworks, with the handler they sit in', () => {
  const result = json(['routes']);
  const found = result.routes.map((route) => `${route.method} ${route.path ?? '(runtime)'}`);
  assert.ok(found.includes('GET /users/:id'), JSON.stringify(found));
  assert.ok(found.includes('POST /users'), JSON.stringify(found));
  assert.ok(found.includes('GET /health'), JSON.stringify(found));
  assert.ok(found.includes('POST /legacy'), JSON.stringify(found));
  assert.ok(found.includes('GET /orders/:orderId'), JSON.stringify(found));

  const express = result.routes.find((route) => route.path === '/users/:id');
  assert.equal(express.framework, 'express-style');
  assert.equal(express.handler.qualified, 'mountUsers', JSON.stringify(express.handler));
  assert.ok(express.confidence > 0 && express.confidence <= 1);
});

test('a path built at runtime is reported as unknown, not guessed', () => {
  const result = json(['routes']);
  const dynamic = result.routes.find((route) => route.file === 'src/http/dynamic.ts');
  assert.ok(dynamic, JSON.stringify(result.routes.map((route) => route.file)));
  assert.equal(dynamic.path, null);
  assert.ok(dynamic.confidence < 0.5, 'a route whose path is a variable cannot be as certain as a literal');
  assert.equal(result.summary.unresolvedPaths, 1);
  assert.ok(result.limits.some((limit) => /variable instead of a literal/.test(limit)), JSON.stringify(result.limits));
});

test('the answer says which frameworks it looked for', () => {
  const result = json(['routes']);
  assert.ok(result.summary.frameworksLookedFor.includes('express-style'), JSON.stringify(result.summary));
  assert.ok(result.summary.frameworksLookedFor.includes('flask'));
  assert.ok(result.summary.frameworksLookedFor.length >= 6);
  assert.ok(result.limits.some((limit) => /not the same as a repository having none/.test(limit)));
  assert.match(cli(repo, ['routes']), /frameworks found: /);
});

test('shape-check finds a duplicate path and a parameter the handler ignores', () => {
  const result = json(['shape-check']);
  const duplicate = result.problems.find((problem) => problem.kind === 'duplicate');
  assert.ok(duplicate, JSON.stringify(result.problems.map((problem) => problem.kind)));
  assert.match(duplicate.message, /POST \/users is declared 2 times/);

  const unbound = result.problems.find((problem) => problem.kind === 'unbound-parameter');
  assert.ok(unbound, JSON.stringify(result.problems));
  assert.match(unbound.message, /orderId/);

  // And it says what it checked, so no problems can be read.
  assert.ok(result.summary.checked.length >= 3, JSON.stringify(result.summary));
});

test('api-impact names the endpoints a declaration answers through', () => {
  const result = json(['api-impact', 'findUser']);
  assert.equal(result.status, 'ok');
  const paths = result.routes.map((route) => `${route.method} ${route.path}`);
  assert.ok(paths.includes('GET /users/:id'), JSON.stringify(result.routes));
  const route = result.routes.find((item) => item.path === '/users/:id');
  assert.ok(route.depth >= 2, `findUser is two calls below the handler: ${JSON.stringify(route)}`);
});

test('a declaration no endpoint reaches says so rather than answering empty', () => {
  const result = json(['api-impact', 'nightlyJob']);
  assert.deepEqual(result.routes, []);
  assert.match(result.summary.note, /No route in this repository reaches this declaration/);
  assert.match(result.summary.note, /would not be found either/, 'the answer has to say what it could not see');
});

test('tools finds what this repository declares, and how it recognised it', () => {
  const result = json(['tools']);
  const tool = result.tools.find((item) => item.name === 'do_the_thing');
  assert.ok(tool, JSON.stringify(result.tools));
  assert.equal(tool.style, 'mcp-sdk-object');
  assert.match(tool.description, /Does the thing/);
  assert.ok(result.summary.stylesLookedFor.length >= 3, JSON.stringify(result.summary));

  // A named object that is not a tool must not be listed as one.
  assert.ok(!result.tools.some((item) => item.name === 'not_a_tool'), JSON.stringify(result.tools));
});

test('an unknown symbol is refused rather than answered with no endpoints', () => {
  const result = cliRaw(repo, ['api-impact', 'noSuchFunction', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'not_found');
});
