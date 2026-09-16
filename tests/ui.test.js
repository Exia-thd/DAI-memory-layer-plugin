/**
 * The viewer.
 *
 * A generated page is easy to get wrong in a way nothing notices: it opens, it
 * is blank, and blank reads as "the graph is empty" rather than "the script did
 * not load". So these check the data is really in the file, and that the failure
 * path says which of the two happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli } from './helpers.js';

function built(repo, args = []) {
  const out = path.join(repo.dir, 'view.html');
  cli(repo, ['ui', ...args, '--out', out]);
  return { out, html: fs.readFileSync(out, 'utf8') };
}

function payloadOf(html) {
  const match = html.match(/window\.__MEMORY__ = (.*?);<\/script>/s);
  assert.ok(match, 'the page carries no embedded data');
  return JSON.parse(match[1].replace(/\u003c/g, '<'));
}

/** Mirrors relatedMemories() in the page: how many memories a click on `node` lists. */
function relatedCount(payload, node) {
  if (payload.memories.some((memory) => memory.id === node.id)) return 1;
  const wanted = new Set();
  if (node.group === 'symbol' || node.group === 'file') {
    const { owner, about } = payload.graph.relations;
    const declared = new Set([node.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, parent] of Object.entries(owner)) {
        if (declared.has(parent) && !declared.has(id)) {
          declared.add(id);
          grew = true;
        }
      }
    }
    for (const id of declared) for (const memoryId of about[id] ?? []) wanted.add(memoryId);
  }
  if (node.group === 'file') {
    for (const memory of payload.memories) {
      if ((memory.sourceRef || '').startsWith(node.label)) wanted.add(memory.id);
    }
  }
  return wanted.size;
}

function seeded() {
  const repo = makeRepo({
    'src/charge.js': 'export function chargeInvoice(invoice) {\n  return psp.capture(invoice.amount);\n}\n',
    'docs/adr.md': '# Thanh toan\n\n## Retry\n\nQuyet dinh: thu lai hai lan.\n',
  });
  cli(repo, ['init', '--no-scan']);
  cli(repo, ['ingest', 'src', 'docs']);
  return repo;
}

test('the page carries its data rather than fetching it', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    const payload = payloadOf(html);

    assert.ok(payload.graph.nodes.length > 0, 'no nodes in the graph');
    assert.ok(payload.memories.length > 0, 'no memories listed');
    assert.ok(payload.health.length > 0, 'no health report');

    // Every link must point at a node that is present, or the graph draws edges
    // into nothing and the layout collapses.
    const present = new Set(payload.graph.nodes.map((node) => node.id));
    for (const link of payload.graph.links) {
      assert.ok(present.has(link.source), `link from a missing node: ${link.source}`);
      assert.ok(present.has(link.target), `link to a missing node: ${link.target}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the graph carries files, declarations and memories', async () => {
  const repo = seeded();
  try {
    const payload = payloadOf(built(repo).html);
    const groups = new Set(payload.graph.nodes.map((node) => node.group));
    assert.ok(groups.has('file'), 'no file nodes');
    assert.ok(groups.has('symbol'), 'no declaration nodes');

    const kinds = new Set(payload.graph.links.map((link) => link.kind));
    assert.ok(kinds.has('DECLARES'), 'files are not linked to what they declare');
    assert.ok(kinds.has('ABOUT'), 'memories are not linked to declarations');
  } finally {
    repo.cleanup();
  }
});

test('a missing script says so instead of showing an empty graph', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    // The failure path has to exist in the file, not in a comment about it.
    assert.match(html, /__GRAPH_FAILED__/, 'no load-failure detection');
    assert.match(html, /could not load/i, 'no message for a failed load');
    assert.match(html, /mermaid/, 'the fallback does not point anywhere useful');
    // Pinned, so the diagram cannot change shape on its own later.
    assert.match(html, /3d-force-graph@\d+\.\d+\.\d+/, 'the library version is not pinned');
  } finally {
    repo.cleanup();
  }
});

test('a path narrows what the page shows', async () => {
  const repo = seeded();
  try {
    const all = payloadOf(built(repo).html);
    const narrowed = payloadOf(built(repo, ['src']).html);
    assert.ok(
      narrowed.graph.nodes.length <= all.graph.nodes.length,
      'the prefix did not narrow anything',
    );
    for (const memory of narrowed.memories) {
      assert.match(memory.sourceRef, /^src/, `${memory.sourceRef} is outside the prefix`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the page states that it is read-only and a snapshot', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    assert.match(html, /read-only/i, 'the page does not say it cannot write');
    assert.match(html, /snapshot/i, 'the page does not say it is a snapshot');
  } finally {
    repo.cleanup();
  }
});

test('the page is light by default and does not follow the operating system', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

    assert.match(html, /<html[^>]+data-theme="light"/, 'the page does not start light');
    assert.ok(
      !css.includes('prefers-color-scheme'),
      'the palette follows the OS, which hands a dark page to someone who asked for white',
    );

    // The canvas does not inherit CSS, so a hardcoded background would ignore
    // the theme entirely -- and a near-white declaration node would vanish on a
    // white ground, which looks like missing nodes rather than a bad palette.
    assert.match(html, /token\('canvas'\)/, 'the 3D background is not read from the palette');
    assert.ok(!/backgroundColor\('#/.test(html), 'the 3D background is hardcoded');

    // Both palettes have to exist, or the toggle switches to nothing.
    assert.match(css, /:root\s*\{/, 'no light palette');
    assert.match(css, /:root\[data-theme="dark"\]\s*\{/, 'no dark palette');
  } finally {
    repo.cleanup();
  }
});

test('clicking any node finds the memory it is about, not only the leaves', async () => {
  // The first version matched a memory whose id equalled the node's, so only
  // leaf nodes did anything. Clicking a file or a declaration was a dead click
  // with no feedback, which reads as a broken page rather than as "nothing here".
  const repo = seeded();
  try {
    const payload = payloadOf(built(repo).html);
    const related = (node) => relatedCount(payload, node);

    const dead = payload.graph.nodes.filter((node) => related(node) === 0);
    assert.equal(
      dead.length, 0,
      `${dead.length} nodes answer nothing when clicked, e.g. ${dead.slice(0, 3).map((n) => n.group + ':' + n.label).join(', ')}`,
    );

    // Files and declarations must be in there, or the check proves nothing.
    const groups = new Set(payload.graph.nodes.map((node) => node.group));
    assert.ok(groups.has('file') && groups.has('symbol'), 'no non-leaf nodes to click');
  } finally {
    repo.cleanup();
  }
});

test('a click that finds nothing still says so', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    assert.match(html, /Nothing is recorded about/, 'an empty result is silent');
    assert.match(html, /show everything/, 'no way back from a narrowed list');
  } finally {
    repo.cleanup();
  }
});

test('under a node budget, the code graph is drawn before file chunks', async () => {
  // Memories went first, so on a real repository 7,567 chunks took all 1,500
  // places and the page called a code graph showed no file and no declaration.
  const repo = seeded();
  try {
    const payload = payloadOf(built(repo, ['--max-nodes', '2']).html);
    const groups = payload.graph.nodes.map((node) => node.group);
    assert.deepEqual(groups.sort(), ['file', 'symbol'], `drawn instead: ${groups.join(', ')}`);
    assert.ok(payload.truncated, 'a cut graph was not reported as cut');
    assert.ok(payload.truncated.omitted.chunks > 0, `omitted: ${JSON.stringify(payload.truncated.omitted)}`);
    assert.ok(payload.memories.length > 0, 'the Memories tab lost what the graph left out');

    // The chunks are not drawn, and their ABOUT links went with them; a click
    // on the declaration must still find what is about it.
    const symbol = payload.graph.nodes.find((node) => node.group === 'symbol');
    assert.ok(relatedCount(payload, symbol) > 0, 'clicking an undrawn memory\'s declaration found nothing');
  } finally {
    repo.cleanup();
  }
});

test('a method hangs off its class, and clicking the class finds what is about its methods', async () => {
  const methods = Array.from({ length: 12 }, (_, i) =>
    `    public Order Load${i}(int id)\n    {\n        // step ${i}: validate, then fetch the order row\n        return _repo.Find(id);\n    }\n`).join('\n');
  const repo = makeRepo({
    'src/OrderService.cs': `namespace Billing.Api;\n\npublic class OrderService\n{\n${methods}}\n`,
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);
    const payload = payloadOf(built(repo).html);
    const byLabel = (label) => payload.graph.nodes.find((node) => node.group === 'symbol' && node.label === label);
    const owner = byLabel('OrderService');
    const method = byLabel('Load7');
    assert.ok(owner && method, 'the class or its method is missing from the graph');

    const declares = payload.graph.links.filter((link) => link.kind === 'DECLARES' && link.target === method.id);
    assert.deepEqual(declares.map((link) => link.source), [owner.id], 'the method is not held by its class');

    // The class is cut between its methods, so later chunks are about methods
    // only; the class still answers for them.
    const aboutClassOnly = (payload.graph.relations.about[owner.id] ?? []).length;
    assert.ok(relatedCount(payload, owner) > aboutClassOnly, 'clicking the class ignores its methods');
  } finally {
    repo.cleanup();
  }
});

/**
 * The camera: an opening move, an idle orbit, and a person who always wins.
 *
 * These assert the page ships the behaviour, not that it looks right -- a WebGL
 * canvas cannot be read back, and a hidden one does not render at all. The
 * behaviour itself was driven in a browser against a generated page of 2,203
 * nodes: the orbit was on after the intro, a pointerdown stopped it, it was
 * still stopped five seconds later, and twelve seconds after the click it was
 * turning again. What these tests catch is the page losing the machinery.
 */
test('the page opens with a camera move and orbits until somebody touches it', () => {
  const repo = seeded();
  try {
    const { html } = built(repo);

    // Orbit controls: the ones with an axis, and the ones autoRotate belongs to.
    assert.match(html, /ForceGraph3D\(\{ controlType: 'orbit' \}\)/);
    assert.match(html, /autoRotate = on/);
    // Centre first, then out to the whole graph -- following the layout while it
    // is still spreading, because a fit taken at load frames a graph the size of
    // a pea and then the graph grows out of frame.
    assert.match(html, /cameraPosition\(\{ x: 0, y: 0, z: 40 \}/);
    // Closer than a plain fit: the library's fitted distance, scaled. The
    // padding knob it offers goes through an arctangent and runs out of range
    // before the view is close.
    assert.match(html, /var CLOSENESS = 0\.62;/);
    assert.match(html, /fitted\.z \* CLOSENESS/);
    assert.match(html, /frame\(ms\);/);
    assert.match(html, /onEngineTick\(function \(\) \{/);
    assert.match(html, /if \(!pullingOut \|\| !graphVisible\) return;/);
    assert.match(html, /onEngineStop\(function \(\) \{/);
    // Ten seconds of nothing brings it back.
    assert.match(html, /var IDLE_MS = 10000;/);
    for (const event of ['pointerdown', 'wheel', 'touchstart']) {
      assert.ok(html.includes(`'${event}'`), `${event} does not stop the orbit`);
    }
    // Reachable from outside, which is the only way any of this can be checked.
    assert.match(html, /window\.__MEMORY_GRAPH__ = graph;/);
  } finally {
    repo.cleanup();
  }
});

test('the graph stops rendering when it is not the tab in front', () => {
  // A canvas behind another panel is frames nobody sees. It cost nothing to
  // leave running and nothing said it was, which is how it stayed that way.
  const repo = seeded();
  try {
    const { html } = built(repo);
    assert.match(html, /pauseAnimation\(\)/);
    assert.match(html, /resumeAnimation\(\)/);
    assert.match(html, /visibilitychange/);
    assert.match(html, /if \(button\.dataset\.tab === 'graph'\) showGraph\(\);/);
  } finally {
    repo.cleanup();
  }
});
