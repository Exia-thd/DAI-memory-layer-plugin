/**
 * Groups of repositories, and the contracts between them.
 *
 * Two repositories: a web app that calls `/api/orders/:id` and `/api/missing`,
 * and a service that answers the first. One repository alone can see neither
 * side of that: the app has a string, the service has a route, and nothing
 * joins them. These check that the join is made, that the call nobody answers
 * is reported rather than dropped, and that a member with no store is named
 * instead of quietly left out.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRepo, cli, cliRaw } from './helpers.js';

const APP = {
  'src/orders/client.ts': [
    'export async function loadOrder(id) {',
    '  const response = await fetch(`/api/orders/${id}`);',
    '  return response.json();',
    '}',
    'export async function loadMissing() {',
    "  const response = await fetch('/api/missing');",
    '  return response.json();',
    '}',
    'export async function loadDynamic(url) {',
    '  const response = await fetch(url);',
    '  return response.json();',
    '}',
  ].join('\n'),
};

const SERVICE = {
  'src/http/orders.ts': [
    "import { findOrder } from '../store/orders';",
    'export function mountOrders(app) {',
    "  app.get('/api/orders/:id', (req, res) => res.json(findOrder(req.params.id)));",
    '}',
  ].join('\n'),
  'src/store/orders.ts': [
    'export function findOrder(id) {',
    '  return { id };',
    '}',
  ].join('\n'),
};

let app;
let service;
let unindexed;

const jsonIn = (repo, args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  app = makeRepo(APP);
  service = makeRepo(SERVICE);
  unindexed = makeRepo({ 'readme.md': '# not indexed\n' });
  // One home for all three, so the group and both stores are visible at once.
  service.home = app.home;
  unindexed.home = app.home;
  cli(app, ['init']);
  cli(service, ['init']);
});

after(() => {
  app?.cleanup();
  service?.cleanup();
  unindexed?.cleanup();
});

test('a group is a list of repositories, created and listed', () => {
  const created = jsonIn(app, ['group', 'create', 'shop', app.dir, service.dir]);
  assert.equal(created.status, 'ok');
  assert.equal(created.group.members.length, 2);

  const listed = jsonIn(app, ['group', 'list']);
  const group = listed.groups.find((entry) => entry.name === 'shop');
  assert.ok(group, JSON.stringify(listed));
  assert.equal(group.members.length, 2);
});

test('a path that is not a directory is refused', () => {
  const result = cliRaw(app, ['group', 'create', 'broken', `${app.dir}/not-here`, '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'no_such_path');
});

test('a call in one repository is matched to the route that answers it', () => {
  const result = jsonIn(app, ['contracts', 'shop']);
  assert.equal(result.status, 'ok');
  const contract = result.contracts.find((item) => item.provider.path === '/api/orders/:id');
  assert.ok(contract, JSON.stringify(result.contracts));
  assert.equal(contract.consumer.caller, 'loadOrder');
  assert.equal(contract.provider.handler, 'mountOrders');
  assert.ok(contract.confidence > 0.4, JSON.stringify(contract));
  assert.match(contract.basis, /placeholders on both sides are collapsed/);
});

test('a call nothing in the group answers is reported, not dropped', () => {
  const result = jsonIn(app, ['contracts', 'shop']);
  const missing = result.unmatched.find((item) => item.path === '/api/missing');
  assert.ok(missing, JSON.stringify(result.unmatched));
  assert.match(missing.reason, /no repository in this group declares that route/);

  const dynamic = result.unmatched.find((item) => item.path === null);
  assert.ok(dynamic, JSON.stringify(result.unmatched));
  assert.match(dynamic.reason, /URL is a variable/);
});

test('a member with no store is named rather than left out', () => {
  cli(app, ['group', 'add', 'shop', unindexed.dir]);
  const result = jsonIn(app, ['contracts', 'shop']);
  const member = result.members.find((entry) => entry.path.includes(unindexed.dir.split(/[\\/]/).pop()));
  assert.ok(member, JSON.stringify(result.members));
  assert.equal(member.indexed, false);
  assert.ok(result.limits.some((limit) => /have no store and were not read/.test(limit)), JSON.stringify(result.limits));

  cli(app, ['group', 'remove', 'shop', unindexed.dir]);
});

test('what contract matching does not check is part of the answer', () => {
  const result = jsonIn(app, ['contracts', 'shop']);
  assert.ok(result.limits.some((limit) => /body a caller sends/.test(limit)), JSON.stringify(result.limits));
  assert.ok(result.limits.some((limit) => /Only the repositories in this group/.test(limit)));
});

test('a group that does not exist is refused, with the ones that do', () => {
  const result = cliRaw(app, ['contracts', 'nope', '--json']);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'no_such_group');
  assert.ok(body.known.includes('shop'), JSON.stringify(body));
});

test('removing and deleting a group does what it says', () => {
  jsonIn(app, ['group', 'create', 'temporary', app.dir]);
  const removed = jsonIn(app, ['group', 'remove', 'temporary', app.dir]);
  assert.equal(removed.group.members.length, 0);

  const deleted = jsonIn(app, ['group', 'delete', 'temporary']);
  assert.equal(deleted.removed, true);
  assert.ok(!jsonIn(app, ['group', 'list']).groups.some((group) => group.name === 'temporary'));
});

test('the text form reads the way the JSON does', () => {
  const text = cli(app, ['contracts', 'shop']);
  assert.match(text, /contract\(s\) between 2 repositor/);
  assert.match(text, /GET \/api\/orders\/:id/);
  assert.match(text, /calls nothing in this group answers/);
  assert.ok(fs.existsSync(app.home), 'the group file lives beside the registry');
});
