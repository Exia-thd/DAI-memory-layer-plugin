/**
 * The tool surface is the part every session pays for.
 *
 * `tools/list` is sent once per session before anyone types, so its size is a
 * recurring cost for every user of this plugin, and it grows by accident: a tool
 * gains a sentence explaining a caveat, the caveat is already in the reply, and
 * nobody measures the difference. Descriptions were 8,506 characters and the whole
 * payload 16,900 before this was pinned.
 *
 * So the rules are tested rather than remembered:
 *
 *   - a description says *when* to reach for the tool. Mechanics and caveats
 *     belong in the reply, where the tools that have them already put them in
 *     `limits`, read at the moment they matter instead of in every session.
 *   - the payload has a budget. Exceeding it is a decision, not a drift: raise the
 *     number here deliberately and the diff shows what it bought.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, PROMPTS } from '../packages/cli/dist/mcp.js';

/** Measured at 12,795 with 35 tools. The headroom is for one more tool, not for prose. */
const PAYLOAD_BUDGET_CHARS = 13_500;
const DESCRIPTION_BUDGET_CHARS = 210;

test('every tool is named once, in this layer namespace', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'a tool name is declared twice');
  for (const name of names) {
    assert.match(name, /^dai_memory_[a-z_]+$/, `${name} is not a dai_memory tool name`);
  }
});

test('every description says when to reach for the tool', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description, `${tool.name} has no description`);
    // "Use ..." is the trigger form. A description that opens by explaining how the
    // tool works is the shape this test exists to keep out.
    assert.match(
      tool.description,
      /^Use /,
      `${tool.name} does not open with a trigger: ${tool.description}`,
    );
  }
});

test('no single description creeps past its budget', () => {
  for (const tool of TOOLS) {
    assert.ok(
      tool.description.length <= DESCRIPTION_BUDGET_CHARS,
      `${tool.name} description is ${tool.description.length} chars, over ${DESCRIPTION_BUDGET_CHARS}`,
    );
  }
});

test('the whole tool list stays inside its per-session budget', () => {
  const payload = JSON.stringify(TOOLS).length;
  assert.ok(
    payload <= PAYLOAD_BUDGET_CHARS,
    `tools/list is ${payload} chars, over the ${PAYLOAD_BUDGET_CHARS} budget. `
      + 'Raise the budget in this test only with a reason: every session pays it.',
  );
});

test('the two tools that are easy to confuse point at each other', () => {
  // Communities in the call graph and communities in the memory graph have almost
  // the same name. Whichever one the model picks first, the description names the
  // other, because picking wrong here is silent: both return plausible groups.
  const code = TOOLS.find((tool) => tool.name === 'dai_memory_code_clusters');
  const memory = TOOLS.find((tool) => tool.name === 'dai_memory_clusters');
  assert.match(code.description, /dai_memory_clusters/);
  assert.match(memory.description, /dai_memory_code_clusters/);
});

test('prompts are declared for every client, not only the one with slash commands', () => {
  const names = PROMPTS.map((prompt) => prompt.name);
  assert.equal(new Set(names).size, names.length, 'a prompt name is declared twice');
  assert.ok(names.includes('memory_search'), 'the search workflow is not a prompt');
  assert.ok(names.includes('memory_why'), 'the why workflow is not a prompt');
  for (const prompt of PROMPTS) {
    assert.ok(prompt.description, `${prompt.name} has no description`);
    assert.match(prompt.description, /^Use /, `${prompt.name} does not open with a trigger`);
    assert.equal(typeof prompt.text, 'function', `${prompt.name} has no body`);
  }
});

test('a prompt body carries its argument and names the tool to call', () => {
  const why = PROMPTS.find((prompt) => prompt.name === 'memory_why');
  const rendered = why.text({ target: 'src/store/store.ts' });
  assert.match(rendered, /src\/store\/store\.ts/, 'the target never reached the prompt body');
  assert.match(rendered, /dai_memory_why/, 'the prompt does not name the tool it is about');

  const commit = PROMPTS.find((prompt) => prompt.name === 'memory_before_commit');
  // The optional argument has a default, so an empty call is still a usable prompt
  // rather than a sentence with a hole in it.
  assert.match(commit.text({}), /staged/);
  assert.match(commit.text({ scope: 'working' }), /working/);
});
