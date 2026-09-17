/**
 * `write --importance` from the command line.
 *
 * The API took an importance and the MCP tool passed one; the CLI had no flag
 * for it. An argument it did not know was parsed into a flag nobody read, so a
 * caller that asked for 9 got the default 5 with no word said -- found by the
 * first program to call this CLI from outside, which needed exactly that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli, cliRaw } from './helpers.js';

function seeded() {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\nA note.\n' });
  cli(repo, ['init', '--no-scan']);
  return repo;
}

function importanceOf(repo, id) {
  return JSON.parse(cli(repo, ['get', id, '--json'])).node.importance;
}

function write(repo, extra = []) {
  return cliRaw(repo, [
    'write', '--layer', 'semantic', '--title', 'PRs stay under 400 lines',
    '--body', 'Chosen because review quality drops past that size.',
    '--source-ref', 'session:test', '--json', ...extra,
  ]);
}

test('an importance given on the command line is the one stored', () => {
  const repo = seeded();
  try {
    const result = write(repo, ['--importance', '9']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(importanceOf(repo, JSON.parse(result.stdout).id), 9);
  } finally {
    repo.cleanup();
  }
});

test('without the flag the default is still five', () => {
  const repo = seeded();
  try {
    const result = write(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(importanceOf(repo, JSON.parse(result.stdout).id), 5);
  } finally {
    repo.cleanup();
  }
});

test('an importance outside 0-10 is refused rather than clamped', () => {
  // A caller asking for 50 has a different scale in mind. Storing 10 would hide
  // that; refusing says it.
  const repo = seeded();
  try {
    for (const value of ['11', '-1', 'high']) {
      const result = write(repo, ['--importance', value]);
      assert.notEqual(result.status, 0, `--importance ${value} was accepted`);
      assert.match(result.stderr, /importance/, result.stderr);
    }
  } finally {
    repo.cleanup();
  }
});
