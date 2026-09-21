/**
 * The grammar runtimes, and what happens when one of them dies.
 *
 * Each grammar is loaded into a WebAssembly runtime of its own -- deliberately,
 * because sharing one made a later grammar's scanner call an earlier one's
 * helper. Those runtimes were never released, so a long scan ended holding one
 * live heap per language, and on a repository of a few thousand files the next
 * parser could not be created: `new Parser()` aborted, the dead runtime stayed
 * cached, and every later file of that language was chunked by character
 * windows with no declarations read. Four hundred shell scripts went that way
 * under a line that said the scan had succeeded.
 *
 * Both halves of the fix are checked here by what they change, not by what
 * still works: how many runtimes get created, and what is reported when one
 * dies. A test that only parses a file passes equally well with the bug.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  newParser, resetGrammarState, lostParserLanguages, grammarLoadCounts, ruleForFile, declarations,
} from '../packages/core/dist/index.js';

const RECYCLE_AFTER = 120;

beforeEach(() => resetGrammarState());
afterEach(() => {
  delete process.env.MEMORY_LAYER_FAIL_PARSER;
});

const use = async (rule, source) => {
  const parser = await newParser(rule);
  if (!parser) return null;
  const tree = parser.parse(source);
  const children = tree?.rootNode?.children?.length ?? 0;
  tree?.delete?.();
  parser.delete?.();
  return children;
};

test('a runtime is retired after its budget, instead of living for the whole run', async () => {
  const rule = ruleForFile('a.ts');
  for (let i = 0; i < RECYCLE_AFTER - 1; i++) await use(rule, `const x${i} = ${i};`);
  assert.equal(grammarLoadCounts().typescript, 1, 'nothing should be recycled before the budget');

  await use(rule, 'const last = 1;');
  await use(rule, 'const afterwards = 2;');
  assert.equal(grammarLoadCounts().typescript, 2, 'the budget must retire the runtime and load a new one');
});

test('parsing is still correct after a retirement', async () => {
  const rule = ruleForFile('a.ts');
  for (let i = 0; i <= RECYCLE_AFTER; i++) await use(rule, `const x${i} = ${i};`);
  assert.ok(grammarLoadCounts().typescript >= 2, JSON.stringify(grammarLoadCounts()));

  const found = await declarations('after.ts', 'export function afterRecycle() {\n  return 1;\n}\n');
  assert.deepEqual(found.map((item) => item.name), ['afterRecycle']);
});

test('a language that loses its parser is reported, and its dead runtime is dropped', async () => {
  const rule = ruleForFile('a.py');
  assert.ok(await use(rule, 'x = 1\n'), 'the language works before the failure');
  assert.equal(grammarLoadCounts().python, 1);

  // What an exhausted runtime does to the next parser.
  process.env.MEMORY_LAYER_FAIL_PARSER = 'python';
  assert.equal(await newParser(rule), null, 'a runtime that cannot make a parser returns none');

  const lost = lostParserLanguages();
  assert.deepEqual(lost.map((entry) => entry.language), ['python']);
  assert.equal(lost[0].failures, 1);
  assert.match(lost[0].reason, /Aborted/);

  // And the dead runtime is gone: the next call loads a new one rather than
  // handing back the same broken module for every later file.
  delete process.env.MEMORY_LAYER_FAIL_PARSER;
  assert.ok(await use(rule, 'y = 2\n'), 'the language recovers on the next file');
  assert.equal(grammarLoadCounts().python, 2, 'the failed runtime must not stay cached');
});

test('failures are counted per language, and only for languages that had a parser', async () => {
  const typescript = ruleForFile('a.ts');
  await use(typescript, 'const a = 1;');

  process.env.MEMORY_LAYER_FAIL_PARSER = 'typescript';
  await newParser(typescript);
  await newParser(typescript);
  delete process.env.MEMORY_LAYER_FAIL_PARSER;

  const lost = lostParserLanguages();
  assert.equal(lost.length, 1, JSON.stringify(lost));
  assert.equal(lost[0].language, 'typescript');
  assert.equal(lost[0].failures, 2);

  // A grammar that never existed is a different thing: no parser was lost,
  // because there was never one to lose. Reporting it as a loss would put a
  // language nobody uses in front of a reader every run.
  resetGrammarState();
  const missing = { ...typescript, label: 'not-a-language', grammar: 'tree-sitter-not-here.wasm', vendored: false };
  assert.equal(await newParser(missing), null);
  assert.deepEqual(lostParserLanguages(), []);
});
