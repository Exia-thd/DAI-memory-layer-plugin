/**
 * taint, explain and pdg.
 *
 * The fixture has four shapes on purpose:
 *
 *   handler  reads req.query and calls runCommand, which runs a shell command
 *   safeHandler  reads req.query, escapes it, then calls runCommand
 *   reportHandler  reads req.query and does nothing dangerous
 *   logRequest  contains the words "import(s)" in a message, and nothing else
 *
 * The first is the finding. The second is the same finding, weaker, because a
 * sanitizer is on the path -- reported rather than dropped, because the
 * sanitizer may apply to something else. The third must produce nothing. The
 * fourth is the false positive a line-based scan makes, and the one this has
 * to refuse.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli, cliRaw } from './helpers.js';

const FILES = {
  'src/web/handler.ts': [
    "import { runCommand } from '../shell/run';",
    'export function handler(req, res) {',
    '  const name = req.query.name;',
    '  // The sentence below is prose inside a declaration that does read',
    '  // untrusted input: a scan that matches it reports a module load here.',
    '  res.setHeader("x-note", `0 import(s) were read`);',
    '  return res.json(runCommand(name));',
    '}',
  ].join('\n'),
  'src/web/safe.ts': [
    "import { runCommand } from '../shell/run';",
    "import { escapeArg } from '../shell/escape';",
    'export function safeHandler(req, res) {',
    '  const name = escapeArg(req.query.name);',
    '  return res.json(runCommand(name));',
    '}',
  ].join('\n'),
  'src/web/report.ts': [
    'export function reportHandler(req, res) {',
    '  const page = req.query.page;',
    '  return res.json({ page });',
    '}',
  ].join('\n'),
  'src/shell/run.ts': [
    "import { execSync } from 'node:child_process';",
    'export function runCommand(argument) {',
    '  return execSync(`ls ${argument}`).toString();',
    '}',
  ].join('\n'),
  'src/shell/escape.ts': [
    'export function escapeArg(value) {',
    '  return escape(String(value));',
    '}',
  ].join('\n'),
  'src/log/prose.ts': [
    'export function logRequest(count) {',
    '  // The word below is prose, not a call: a line-based scan must not read it as one.',
    '  return `${count} import(s) were read`;',
    '}',
  ].join('\n'),
  // For pdg: names set once, set twice, and read under a condition.
  'src/calc/total.ts': [
    'export function total(items, discount) {',
    '  let sum = 0;',
    '  for (const item of items) {',
    '    sum = sum + item.price;',
    '  }',
    '  if (discount) {',
    '    sum = sum - discount;',
    '  }',
    '  return sum;',
    '}',
  ].join('\n'),
};

let repo;
const json = (args) => JSON.parse(cli(repo, [...args, '--json']));

before(() => {
  repo = makeRepo(FILES);
  cli(repo, ['init']);
});

after(() => repo?.cleanup());

test('a source in one declaration and a sink in another it calls is a finding', () => {
  const result = json(['taint']);
  const finding = result.findings.find((item) =>
    item.source.symbol.qualified === 'handler' && item.sink.symbol.qualified === 'runCommand');
  assert.ok(finding, JSON.stringify(result.findings.map((item) => `${item.source.symbol.qualified}->${item.sink.symbol.qualified}`)));
  assert.equal(finding.source.hit.marker, 'http-request');
  assert.equal(finding.sink.hit.marker, 'shell');
  assert.deepEqual(finding.path.map((hop) => hop.qualified), ['runCommand']);
  assert.equal(finding.sanitizers.length, 0);
  assert.ok(finding.confidence > 0.5, JSON.stringify(finding));
});

test('a sanitizer on the path weakens the finding rather than removing it', () => {
  const result = json(['taint']);
  const direct = result.findings.find((item) => item.source.symbol.qualified === 'handler');
  const sanitised = result.findings.find((item) => item.source.symbol.qualified === 'safeHandler');
  assert.ok(sanitised, 'a sanitised path must still be reported');
  assert.ok(sanitised.sanitizers.length > 0, JSON.stringify(sanitised));
  assert.ok(sanitised.confidence < direct.confidence, `${sanitised.confidence} should be below ${direct.confidence}`);
  assert.match(sanitised.why, /may or may not apply/);
  assert.ok(result.summary.mitigated >= 1);
});

test('untrusted input that reaches nothing dangerous is not a finding', () => {
  const result = json(['taint']);
  assert.ok(!result.findings.some((item) => item.source.symbol.qualified === 'reportHandler'),
    JSON.stringify(result.findings.map((item) => item.source.symbol.qualified)));
});

test('prose that looks like a call is not a sink', () => {
  const result = json(['taint']);
  // Neither in a declaration nothing reaches...
  assert.ok(!result.findings.some((item) => item.sink.symbol.qualified === 'logRequest'),
    JSON.stringify(result.findings.map((item) => `${item.sink.symbol.qualified}:${item.sink.hit.text}`)));
  // ...nor inside one that does read untrusted input, where a loose pattern
  // would turn an English sentence into a reported module load.
  assert.ok(!result.findings.some((item) => item.sink.hit.marker === 'dynamic-import'),
    JSON.stringify(result.findings.map((item) => `${item.sink.hit.marker}: ${item.sink.hit.text}`)));
});

test('what it claims and what it does not are part of the answer', () => {
  const result = json(['taint']);
  assert.ok(result.limits.some((limit) => /does not track values/.test(limit)), JSON.stringify(result.limits));
  assert.ok(result.limits.some((limit) => /Nothing here is a vulnerability report/.test(limit)), JSON.stringify(result.limits));
  assert.ok(result.summary.declarationsScanned > 0 && result.summary.withSources > 0, JSON.stringify(result.summary));
});

test('explain answers for one declaration, and says so when there is nothing', () => {
  const dangerous = json(['explain', 'runCommand']);
  assert.equal(dangerous.status, 'ok');
  assert.ok(dangerous.summary.asSink >= 1, JSON.stringify(dangerous.summary));
  assert.ok(dangerous.findings.length > 0);

  const quiet = json(['explain', 'reportHandler']);
  assert.deepEqual(quiet.findings, []);
  assert.match(quiet.summary.note, /not the same as it being safe/);
});

test('explain takes a file as well as a declaration', () => {
  const result = json(['explain', 'src/shell/run.ts']);
  assert.equal(result.status, 'ok');
  assert.ok(result.findings.length > 0, JSON.stringify(result));
  assert.equal(result.target.file, 'src/shell/run.ts');
});

test('pdg reads the inside of one declaration from its syntax tree', () => {
  const result = json(['pdg', 'total']);
  assert.equal(result.status, 'ok');
  assert.equal(result.language, 'typescript');
  const byName = Object.fromEntries(result.names.map((name) => [name.name, name]));

  // sum is given a value three times and read in several places.
  assert.ok(byName.sum.definedAt.length >= 2, JSON.stringify(byName.sum));
  assert.ok(byName.sum.usedAt.length >= 2, JSON.stringify(byName.sum));
  // discount is a parameter, read only inside the condition.
  assert.ok(byName.discount, JSON.stringify(Object.keys(byName)));
  assert.equal(byName.discount.underControl, true);

  // The conditional and the loop are both reported as regions.
  const kinds = result.control.map((region) => region.kind);
  assert.ok(kinds.some((kind) => /if/.test(kind)), JSON.stringify(kinds));
  assert.ok(kinds.some((kind) => /for/.test(kind)), JSON.stringify(kinds));
  assert.ok(result.limits.some((limit) => /Not tracked/.test(limit)));
});

test('a declaration in a language with no syntax tree says so rather than answering', () => {
  const result = cliRaw(repo, ['pdg', 'noSuchDeclaration', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'not_found');
});

test('the text forms read the way the JSON does', () => {
  assert.match(cli(repo, ['taint']), /place\(s\) where untrusted input could reach something dangerous/);
  assert.match(cli(repo, ['taint']), /from {2}handler {2}src\/web\/handler\.ts:\d+/);
  assert.match(cli(repo, ['pdg', 'total']), /names:/);
  assert.match(cli(repo, ['explain', 'runCommand']), /place\(s\) worth reading/);
});
