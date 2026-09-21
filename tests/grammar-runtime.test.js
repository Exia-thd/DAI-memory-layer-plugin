/**
 * The grammar runtimes, and what happens when one of them dies.
 *
 * A scan of a repository's shell scripts lost nearly all their declarations.
 * The cause was the bash grammar: the build tree-sitter-wasms ships fails on
 * any `case ... in`, its runtime aborts, and -- because the dead runtime stayed
 * cached -- every later bash file failed too, under a line that said the scan
 * had succeeded. It looked like memory exhaustion from long-lived runtimes, and
 * the first fix treated it as that; the last test below is the one that names
 * the real cause.
 *
 * Three things are checked, each by what it changes rather than by what still
 * works: runtimes are retired after a budget, a dead runtime is dropped and the
 * loss reported, and bash with a `case` keeps its declarations. A test that
 * only parses a simple file passes equally well with every one of these bugs.
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

/**
 * The case that was actually breaking shell scripts.
 *
 * The bash grammar tree-sitter-wasms ships fails on any `case ... in`: its
 * scanner calls a function the runtime does not export, and the runtime aborts
 * after it. Almost every real script has one, so a scan of a repository's
 * scripts lost nearly all of them -- and every earlier probe used a function
 * with no `case`, which parsed fine and hid it.
 */
test('a bash script with a case statement keeps its declarations', async () => {
  const script = [
    '#!/usr/bin/env bash',
    'main() {',
    '  local command="${1:-}"',
    '  case "$command" in',
    '    start) run_start ;;',
    '    *) echo "unknown" >&2; return 1 ;;',
    '  esac',
    '}',
    'run_start() {',
    '  echo starting',
    '}',
  ].join('\n');

  // Several in a row: the broken grammar poisoned its runtime, so the second
  // file failed even when the first had been recovered from.
  for (let i = 0; i < 3; i++) {
    const found = await declarations(`script-${i}.sh`, script);
    assert.deepEqual(found.map((item) => item.name).sort(), ['main', 'run_start']);
  }
  assert.deepEqual(lostParserLanguages(), []);
});
