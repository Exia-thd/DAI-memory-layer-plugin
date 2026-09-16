/**
 * The viewer, as one HTML file with the data baked in.
 *
 * No server, no build step, no framework. It opens from the filesystem, which is
 * the difference between a thing people look at and a thing they mean to set up
 * one day.
 *
 * Read-only on purpose. Every write in this system is a short-lived process, and
 * that is what lets several sessions run at once without fighting over the store;
 * a page holding a write connection would break exactly that. Where an action
 * would change something, the page hands you the command instead.
 */

/** Pinned, not floated. A range would let the graph change shape on its own. */
const FORCE_GRAPH_3D = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.0/dist/3d-force-graph.min.js';

export interface UiPayload {
  project: string;
  generatedAt: string;
  stats: {
    nodes: number; edges: number; symbols: number; files: number;
    calls: number; inherits: number; imports: number;
  };
  health: Array<{ name: string; status: string; detail: string }>;
  graph: {
    nodes: Array<{ id: string; label: string; kind: string; group: string; detail?: string }>;
    links: Array<{ source: string; target: string; kind: string; detail?: string }>;
    /**
     * Every declaration's relations, whether or not the budget drew it:
     * `owner` maps a declaration to what encloses it (a declaration or
     * `file:<path>`), `about` to the memories about it.
     */
    relations: {
      owner: Record<string, string>;
      about: Record<string, string[]>;
      /** What each declaration calls, and what calls it, whether drawn or not. */
      calls: Record<string, string[]>;
      calledBy: Record<string, string[]>;
    };
  };
  memories: Array<{
    id: string;
    layer: string;
    title: string;
    body: string;
    sourceRef: string;
    importance: number;
    ageDays: number;
    edges: number;
    contested: boolean;
  }>;
  /** Set when the graph was cut to its node budget: how many there were, and what was left out. */
  truncated: { nodes: number; omitted?: Record<string, number> } | null;
}

export function renderUi(payload: UiPayload): string {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(payload.project)} — memory</title>
<style>
  /*
   * Light by default, because that is what was asked for. Not a media query:
   * following the operating system would hand a dark page to someone who
   * explicitly wanted a white one. The toggle is there for the other mood.
   *
   * Every colour is a token, including the two the 3D canvas reads, so the
   * toggle changes the graph as well as the page. The first version hardcoded
   * the canvas background and made declaration nodes near-white -- on a white
   * ground they would simply have vanished, which looks like a graph with
   * missing nodes rather than a palette that does not work.
   */
  :root {
    --bg: #ffffff;
    --canvas: #f5f9fd;
    --panel: #f2f6fb;
    --panel-2: #e8eff7;
    --line: #d5e0ec;
    --ink: #0f1c28;
    --muted: #5a6b7d;
    --accent: #1c6fd4;
    --warn: #9a6700;
    --bad: #cf222e;
    --good: #1a7f37;

    --file: #64798f;
    --symbol: #1f4e79;
    --semantic: #7b3fd4;
    --episodic: #1a7f37;
    --procedural: #bc4c00;
    --artifact: #1c6fd4;
    --link: #b9c9da;
    --call: #1c6fd4;
    --inherit: #7b3fd4;
    --import: #1a7f37;

    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }

  :root[data-theme="dark"] {
    --bg: #0d1117;
    --canvas: #0d1117;
    --panel: #161b22;
    --panel-2: #1c2129;
    --line: #21262d;
    --ink: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --warn: #d29922;
    --bad: #f85149;
    --good: #3fb950;

    --file: #8b949e;
    --symbol: #e6edf3;
    --semantic: #a371f7;
    --episodic: #3fb950;
    --procedural: #db6d28;
    --artifact: #58a6ff;
    --link: #30363d;
    --call: #58a6ff;
    --inherit: #a371f7;
    --import: #3fb950;
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  nav { margin-left: auto; display: flex; gap: 4px; align-items: center; }
  nav button { background: transparent; color: var(--muted); border: 1px solid transparent;
    padding: 5px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  nav button[aria-selected="true"] { background: var(--bg); color: var(--ink); border-color: var(--line); }
  nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #theme { font-family: var(--mono); font-size: 12px; margin-left: 8px; border-color: var(--line); }

  main { position: relative; height: calc(100vh - 52px); }
  section { display: none; height: 100%; }
  section[data-active] { display: block; }

  #graph { width: 100%; height: 100%; background: var(--canvas); }
  .legend, .hint { background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line); border-radius: 8px; }
  .legend { position: absolute; left: 14px; bottom: 14px; padding: 10px 12px; font-size: 12px; }
  .legend div { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .line { width: 12px; height: 2px; border-radius: 1px; }
  .hint { position: absolute; right: 14px; top: 14px; color: var(--muted);
    font-size: 12px; padding: 8px 12px; }
  #fallback { display: none; padding: 40px; max-width: 620px; }
  #fallback code { font-family: var(--mono); background: var(--panel-2); padding: 2px 6px; border-radius: 4px; }

  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); height: 100%; }
  .list { overflow: auto; border-right: 1px solid var(--line); }
  .controls { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--bg); flex-wrap: wrap; }
  .controls input, .controls select { background: var(--bg); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; font: inherit; }
  .controls input { flex: 1; min-width: 180px; }
  .controls input:focus-visible, .controls select:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 1px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); font-weight: 500; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  td { padding: 8px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--panel); }
  tbody tr[aria-selected="true"] { background: var(--panel-2); }
  .pill { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid currentColor; white-space: nowrap; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  .detail { overflow: auto; padding: 16px 18px; }
  .detail h2 { font-size: 15px; margin: 0 0 4px; }
  .detail pre { white-space: pre-wrap; word-break: break-word; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-family: var(--mono); font-size: 12px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 12px 0; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; font-family: var(--mono); word-break: break-all; }
  .empty { color: var(--muted); padding: 40px 18px; }
  .banner { margin: 0; padding: 9px 14px; background: var(--panel-2); font-size: 12px;
    color: var(--ink); border-bottom: 1px solid var(--line); }
  .banner button { background: none; border: none; padding: 0; font: inherit;
    color: var(--accent); text-decoration: underline; cursor: pointer; }
  .banner button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .health { padding: 14px 18px; }
  .health div { display: grid; grid-template-columns: 150px 60px 1fr; gap: 12px;
    padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; align-items: start; }
  .health .st { font-family: var(--mono); font-size: 11px; }
  .ok { color: var(--good); } .warn { color: var(--warn); } .fail { color: var(--bad); }
  .note { color: var(--muted); font-size: 12px; padding: 0 18px 18px; max-width: 70ch; }
  .note code { font-family: var(--mono); background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(payload.project)}</h1>
  <span class="sub">${payload.stats.nodes} memories · ${payload.stats.symbols} declarations · ${payload.stats.files} files · ${payload.stats.calls} calls · ${payload.stats.imports} imports · ${escapeHtml(payload.generatedAt.slice(0, 16).replace('T', ' '))}</span>
  <nav role="tablist">
    <button role="tab" aria-selected="true" data-tab="graph">Graph</button>
    <button role="tab" aria-selected="false" data-tab="memories">Memories</button>
    <button role="tab" aria-selected="false" data-tab="health">Health</button>
    <button id="theme" type="button" title="Switch theme">dark</button>
  </nav>
</header>

<main>
  <section data-panel="graph" data-active>
    <div id="graph"></div>
    <div class="hint">drag to orbit · scroll to zoom · click a node</div>
    <div class="legend">
      <div><span class="dot" style="background:var(--file)"></span> file</div>
      <div><span class="dot" style="background:var(--symbol)"></span> declaration</div>
      <div><span class="dot" style="background:var(--semantic)"></span> semantic</div>
      <div><span class="dot" style="background:var(--episodic)"></span> episodic</div>
      <div><span class="dot" style="background:var(--procedural)"></span> procedural</div>
      <div><span class="dot" style="background:var(--artifact)"></span> artifact</div>
      <div><span class="line" style="background:var(--call)"></span> calls</div>
      <div><span class="line" style="background:var(--inherit)"></span> inherits</div>
      <div><span class="line" style="background:var(--import)"></span> imports</div>
    </div>
    <div id="fallback">
      <h2>The 3D view could not load</h2>
      <p>It is fetched from a CDN, so this page needs a network the first time it
        is opened. The other tabs work regardless — they carry their data inline.</p>
      <p>For a diagram that needs nothing at all: <code>dai-memory map --format mermaid</code></p>
    </div>
  </section>

  <section data-panel="memories">
    <div class="split">
      <div class="list">
        <div class="controls">
          <input id="q" type="search" placeholder="Filter by title, body or path" aria-label="Filter memories">
          <select id="layer" aria-label="Filter by layer">
            <option value="">every layer</option>
            <option value="semantic">semantic</option>
            <option value="episodic">episodic</option>
            <option value="procedural">procedural</option>
            <option value="artifact">artifact</option>
          </select>
          <select id="sort" aria-label="Sort">
            <option value="importance">most important</option>
            <option value="age">newest</option>
            <option value="edges">most connected</option>
          </select>
        </div>
        <p class="banner" id="banner" hidden></p>
        <table>
          <thead><tr><th>Layer</th><th>Title</th><th class="num">Imp</th><th class="num">Age</th><th class="num">Links</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <p class="empty" id="none" hidden>Nothing matches that filter.</p>
      </div>
      <div class="detail" id="detail"><p class="empty">Select a memory.</p></div>
    </div>
  </section>

  <section data-panel="health">
    <div class="health" id="health"></div>
    <p class="note">
      This page is read-only. Every write in this system is a short-lived process,
      which is what lets several sessions run at once without fighting over the
      store — a page holding a write connection would break that. To change
      something, run the command: <code>dai-memory prune</code>,
      <code>dai-memory ingest --force</code>, <code>dai-memory embed --force</code>,
      <code>dai-memory merge</code>. Re-run <code>dai-memory ui</code> afterwards; this
      file is a snapshot, not a live view.
    </p>
  </section>
</main>

<script>window.__MEMORY__ = ${data};</script>
<script src="${FORCE_GRAPH_3D}" onerror="window.__GRAPH_FAILED__ = true"></script>
<script>
(function () {
  var data = window.__MEMORY__;
  var root = document.documentElement;

  /** Read a colour from the stylesheet, so the palette lives in exactly one place. */
  function token(name) {
    return getComputedStyle(root).getPropertyValue('--' + name).trim();
  }

  // ---- tabs ----
  var buttons = document.querySelectorAll('nav button[data-tab]');
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      buttons.forEach(function (other) { other.setAttribute('aria-selected', String(other === button)); });
      document.querySelectorAll('section').forEach(function (section) {
        if (section.dataset.panel === button.dataset.tab) section.setAttribute('data-active', '');
        else section.removeAttribute('data-active');
      });
      // A WebGL canvas goes on rendering while it sits behind another panel:
      // the library's loop keeps asking for frames, the GPU keeps drawing them,
      // and nobody can see any of it. It renders while it is the tab in front,
      // and not otherwise -- and coming back to it replays the opening move, so
      // the view is one somebody can read rather than wherever the camera was
      // left.
      if (button.dataset.tab === 'graph') showGraph();
      else hideGraph();
    });
  });

  // ---- theme ----
  var themeButton = document.getElementById('theme');
  var stored = null;
  try { stored = localStorage.getItem('memory-ui-theme'); } catch (err) { stored = null; }
  if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);

  function syncThemeLabel() {
    themeButton.textContent = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  }
  syncThemeLabel();

  themeButton.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('memory-ui-theme', next); } catch (err) { /* private window */ }
    syncThemeLabel();
    repaintGraph();
  });

  // ---- graph ----
  var graph = null;

  function linkColor(link) {
    if (link.kind === 'CONTRADICTS') return token('bad');
    if (link.kind === 'CALLS') return token('call');
    if (link.kind === 'INHERITS') return token('inherit');
    if (link.kind === 'IMPORTS') return token('import');
    return token('link');
  }

  function colorFor(node) {
    return token(node.group === 'file' ? 'file' : node.group === 'symbol' ? 'symbol' : node.group)
      || token('muted');
  }

  function repaintGraph() {
    if (!graph) return;
    // The canvas does not inherit CSS, so the theme has to be pushed into it.
    graph.backgroundColor(token('canvas'))
      .nodeColor(colorFor)
      .linkColor(linkColor);
  }

  if (window.__GRAPH_FAILED__ || typeof ForceGraph3D !== 'function') {
    // Said out loud. A blank canvas reads as "there is nothing in the graph",
    // which is a different and much worse message than "the library is missing".
    document.getElementById('graph').style.display = 'none';
    document.getElementById('fallback').style.display = 'block';
  } else {
    // Orbit rather than the default trackball: it is the one with an axis, which
    // is what makes an unattended turn look deliberate instead of a tumble.
    graph = ForceGraph3D({ controlType: 'orbit' })(document.getElementById('graph'))
      .graphData({
        nodes: data.graph.nodes.map(function (n) { return Object.assign({}, n); }),
        links: data.graph.links.map(function (l) { return Object.assign({}, l); }),
      })
      .nodeLabel(function (n) { return n.label + (n.detail ? '\\n' + n.detail : ''); })
      .nodeVal(function (n) { return n.group === 'file' ? 6 : n.group === 'symbol' ? 3 : 2; })
      .linkWidth(function (l) { return l.kind === 'CONTRADICTS' ? 2 : l.kind === 'CALLS' ? 1 : 0.5; })
      .linkDirectionalArrowLength(function (l) { return l.kind === 'CALLS' || l.kind === 'INHERITS' ? 3 : 0; })
      .linkDirectionalArrowRelPos(1)
      .linkLabel(function (l) { return l.kind.toLowerCase() + (l.detail ? ' (' + l.detail + ')' : ''); })
      .linkOpacity(0.65)
      .onNodeClick(function (node) {
        var distance = 90;
        var ratio = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        graph.cameraPosition(
          { x: (node.x || 0) * ratio, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio },
          node, 900,
        );
        openRelated(node);
      });

    repaintGraph();
    window.addEventListener('resize', function () {
      graph.width(window.innerWidth).height(window.innerHeight - 52);
    });
    graph.width(window.innerWidth).height(window.innerHeight - 52);
  }

  /**
   * The opening move, the idle orbit, and the rule that a person always wins.
   *
   * A graph that opens wherever the layout happened to leave the camera reads as
   * a mess; the same graph, seen from the middle and then pulled out to its full
   * extent, reads as a shape. So: start at the centre, pull out to fit, and turn
   * slowly. The turning is for nobody in particular -- it is what makes a still
   * picture legible as a three-dimensional one -- so it stops the moment somebody
   * touches the view, and comes back only after they have left it alone.
   *
   * Every one of these is off while the tab is in the background or the window
   * is hidden. A camera animating into an invisible canvas is pure heat.
   */
  var IDLE_MS = 10000;
  var idleTimer = null;
  var introTimer = null;
  var orbiting = false;
  var graphVisible = true;
  /** True while the opening pull-out is following the layout outwards. */
  var pullingOut = false;
  var settled = false;
  var lastFit = 0;

  function controls() { return graph && graph.controls ? graph.controls() : null; }

  function orbit(on) {
    var c = controls();
    if (!c) return;
    orbiting = on;
    c.autoRotate = on;
  }

  /**
   * How much of the library's own fitted distance the view actually sits at.
   *
   * A plain fit puts the whole graph on screen and a good deal of nothing around
   * it, which at this scale reads as a smudge in the middle of a window. The
   * obvious knob is zoomToFit's padding, and it is a bad one: the distance it
   * computes goes through an arctangent, so doubling the padding buys about a
   * tenth of the distance and the control runs out before the view is close.
   * Scaling the distance it arrives at is linear and says what it means -- 0.62
   * is a bit under two thirds of the way in from the fit.
   */
  var CLOSENESS = 0.62;

  /**
   * Frames the whole graph, closer.
   *
   * The library's fit is applied with no transition, read back, scaled, and the
   * camera put back where it was -- all in one turn of the event loop, so no
   * frame is ever drawn at the intermediate place and nothing flickers. Reusing
   * its arithmetic rather than restating it here means the framing cannot drift
   * from what zoomToFit would have done.
   */
  function frame(ms) {
    if (!graph || !graphVisible) return;
    var before = graph.cameraPosition();
    graph.zoomToFit(0, 0);
    var fitted = graph.cameraPosition();
    graph.cameraPosition({ x: before.x, y: before.y, z: before.z }, undefined, 0);
    graph.cameraPosition({
      x: fitted.x * CLOSENESS,
      y: fitted.y * CLOSENESS,
      z: fitted.z * CLOSENESS,
    }, { x: 0, y: 0, z: 0 }, ms);
  }

  /** Pull out to the whole graph, then turn. Used by the intro and by going idle. */
  function overview(ms) {
    if (!graph || !graphVisible) return;
    pullingOut = false;
    frame(ms);
    clearTimeout(introTimer);
    introTimer = setTimeout(function () { orbit(true); }, ms + 60);
  }

  /**
   * The opening pull-out, which has to follow a graph that is still growing.
   *
   * A layout starts collapsed around the origin and spreads over the seconds
   * that follow. Fitting the view once, at load, fits that first tight ball --
   * and then the graph grows out of frame while the camera sits where it was
   * put, which reads as an opening move that never happened. It did happen; it
   * framed a graph the size of a pea.
   *
   * So the camera keeps fitting, a few times a second, for as long as the
   * engine is still moving nodes: the view pulls outwards because the graph is
   * pushing outwards. When the engine stops, one last fit settles it and the
   * turn begins.
   */
  function intro() {
    if (!graph || !graphVisible) return;
    orbit(false);
    clearTimeout(introTimer);
    // At the centre first, looking out from inside the graph. Distance rather
    // than zero, because a camera exactly on the origin has nothing to look at
    // and the first frame flickers.
    graph.cameraPosition({ x: 0, y: 0, z: 40 }, { x: 0, y: 0, z: 0 }, 0);

    if (settled) {
      // Nothing is moving any more -- coming back to the tab, or a small graph
      // that finished before anyone looked. One fit is the whole pull-out.
      overview(1600);
      return;
    }
    pullingOut = true;
    lastFit = 0;
  }

  /** A person did something. The orbit stops until they stop. */
  function interacted() {
    if (!graphVisible) return;
    clearTimeout(introTimer);
    // Their view now, not the camera's: the pull-out stops following as well,
    // or the layout would drag the frame around under their hands.
    pullingOut = false;
    orbit(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { overview(1200); }, IDLE_MS);
  }

  function showGraph() {
    if (!graph) return;
    graphVisible = true;
    graph.resumeAnimation();
    intro();
  }

  function hideGraph() {
    if (!graph) return;
    graphVisible = false;
    pullingOut = false;
    clearTimeout(idleTimer);
    clearTimeout(introTimer);
    orbit(false);
    graph.pauseAnimation();
  }

  function startCamera() {
    var canvas = document.getElementById('graph');

    // Four fits a second while the layout expands: enough that the pull-out
    // looks continuous, few enough that measuring the graph's extent is not
    // what the frame budget goes on.
    graph.onEngineTick(function () {
      if (!pullingOut || !graphVisible) return;
      var now = Date.now();
      if (now - lastFit < 250) return;
      lastFit = now;
      frame(260);
    });

    graph.onEngineStop(function () {
      settled = true;
      if (!pullingOut || !graphVisible) return;
      overview(900);
    });
    // pointerdown rather than click: dragging the view is the commonest way to
    // take hold of it, and it must stop the orbit at the first movement rather
    // than when the button comes back up.
    ['pointerdown', 'wheel', 'touchstart'].forEach(function (name) {
      canvas.addEventListener(name, interacted, { passive: true });
    });
    document.addEventListener('keydown', function () { if (graphVisible) interacted(); });

    // A hidden window still runs requestAnimationFrame in some browsers, and a
    // backgrounded tab that keeps a GPU busy is the kind of thing people notice
    // on a laptop battery and never trace back.
    document.addEventListener('visibilitychange', function () {
      var active = document.querySelector('section[data-panel="graph"][data-active]');
      if (document.hidden) { graph.pauseAnimation(); clearTimeout(idleTimer); clearTimeout(introTimer); }
      else if (active) {
        graph.resumeAnimation();
        // A page opened in a background tab has had no frames, so its layout
        // has not moved and its opening move has not run. Coming to it for the
        // first time should play that move, not count as somebody taking hold
        // of a view they have not seen yet.
        if (settled) interacted();
        else intro();
      }
    });

    intro();
  }

  // After the definitions, not inside the block above: a var hoists its name
  // and not its value, so calling this any earlier ran it with graphVisible
  // still undefined and the opening move never played.
  if (graph) startCamera();

  // The graph instance, reachable from outside the page.
  //
  // Not for the page itself, which closes over it: for checking it. Everything
  // this file does to the camera -- the opening pull-out, the idle orbit, the
  // stop on a click -- is invisible to anything that can only read the DOM, and
  // a WebGL canvas cannot be read back at all. A test that cannot see the camera
  // can only assert that the code mentioning it exists, which is not the same
  // claim. Read-only by convention; nothing here reads it back.
  window.__MEMORY_GRAPH__ = graph;


  /**
   * Which memories a node is about.
   *
   * The first version matched a memory whose id equalled the node's, so only the
   * leaves did anything -- clicking a file or a declaration was a dead click with
   * no feedback, which reads as a broken page rather than as "nothing here".
   *
   * A declaration answers with what points at it; a file answers with everything
   * its declarations carry, plus anything recorded straight against the path,
   * which is how markdown and other files with no declarations still respond.
   *
   * Read from the original payload, not from the graph's copy: the layout engine
   * replaces link endpoints with node objects once it has run, so link.source is
   * a string here and an object in there.
   */
  /** owner -> the declarations it encloses, built once from the full relations. */
  var enclosed = null;

  function relatedMemories(node) {
    var direct = data.memories.find(function (m) { return m.id === node.id; });
    if (direct) return [direct];

    var wanted = {};

    if (node.group === 'symbol' || node.group === 'file') {
      // Everything the node declares, however deep and whether or not it was
      // drawn: a class answers for its methods too. Read from the relations,
      // not the drawn links, which lose whatever the node budget left out.
      var relations = data.graph.relations || { owner: {}, about: {} };
      if (!enclosed) {
        enclosed = {};
        Object.keys(relations.owner).forEach(function (id) {
          var owner = relations.owner[id];
          (enclosed[owner] = enclosed[owner] || []).push(id);
        });
      }
      var stack = [node.id];
      var seen = {};
      while (stack.length > 0) {
        var id = stack.pop();
        if (seen[id]) continue;
        seen[id] = true;
        (relations.about[id] || []).forEach(function (memoryId) { wanted[memoryId] = true; });
        (enclosed[id] || []).forEach(function (child) { stack.push(child); });
      }
    }

    if (node.group === 'file') {
      // Files whose content was chunked but which declare nothing -- markdown,
      // config, anything the grammar does not read -- still have memory against
      // the path itself.
      var prefix = node.label;
      data.memories.forEach(function (memory) {
        if ((memory.sourceRef || '').indexOf(prefix) === 0) wanted[memory.id] = true;
      });
    }

    return data.memories.filter(function (memory) { return wanted[memory.id]; });
  }

  function openRelated(node) {
    var found = relatedMemories(node);
    focus = found.length > 0 ? found.map(function (memory) { return memory.id; }) : null;
    focusLabel = node.label;

    // Every click says something, including the ones that find nothing. A click
    // that silently does nothing is indistinguishable from a broken control.
    document.querySelector('nav button[data-tab="memories"]').click();
    if (found.length > 0) select(found[0]);
    else { selected = null; detail.innerHTML = ''; render(); }
  }

  // ---- memories ----
  var rows = document.getElementById('rows');
  var none = document.getElementById('none');
  var detail = document.getElementById('detail');
  var banner = document.getElementById('banner');
  var q = document.getElementById('q');
  var layer = document.getElementById('layer');
  var sort = document.getElementById('sort');
  var selected = null;
  /** Set by a graph click, cleared as soon as the user filters by hand. */
  var focus = null;
  var focusLabel = '';

  function text(value) { return String(value == null ? '' : value); }

  function visible() {
    var needle = q.value.trim().toLowerCase();
    var want = layer.value;
    var list = data.memories.filter(function (m) {
      if (focus && focus.indexOf(m.id) === -1) return false;
      if (want && m.layer !== want) return false;
      if (!needle) return true;
      return (m.title + ' ' + m.body + ' ' + m.sourceRef).toLowerCase().indexOf(needle) !== -1;
    });
    var key = sort.value;
    return list.sort(function (a, b) {
      if (key === 'age') return a.ageDays - b.ageDays;
      if (key === 'edges') return b.edges - a.edges;
      return b.importance - a.importance;
    });
  }

  function select(memory) {
    selected = memory.id;
    detail.innerHTML = '<h2></h2><div class="kv"></div><pre></pre>';
    detail.querySelector('h2').textContent = memory.title;
    var kv = detail.querySelector('.kv');
    [['layer', memory.layer], ['source', memory.sourceRef], ['importance', memory.importance],
     ['age', memory.ageDays + ' days'], ['links', memory.edges],
     ['contested', memory.contested ? 'yes — a person settles this' : 'no'],
     ['id', memory.id]].forEach(function (pair) {
      var dt = document.createElement('dt'); dt.textContent = pair[0];
      var dd = document.createElement('dd'); dd.textContent = text(pair[1]);
      kv.appendChild(dt); kv.appendChild(dd);
    });
    detail.querySelector('pre').textContent = memory.body;
    render();
  }

  function render() {
    var list = visible();
    rows.textContent = '';
    none.hidden = list.length > 0;

    banner.hidden = !focus && !focusLabel;
    if (!banner.hidden) {
      banner.textContent = focus
        ? 'Showing ' + focus.length + ' memor' + (focus.length === 1 ? 'y' : 'ies') +
          ' about ' + focusLabel + ' — '
        : 'Nothing is recorded about ' + focusLabel + ' — ';
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'show everything';
      clear.addEventListener('click', function () {
        focus = null; focusLabel = ''; render();
      });
      banner.appendChild(clear);
    }

    list.forEach(function (memory) {
      var tr = document.createElement('tr');
      if (memory.id === selected) tr.setAttribute('aria-selected', 'true');

      var layerCell = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill';
      pill.style.color = token(memory.layer) || token('muted');
      pill.textContent = memory.layer;
      layerCell.appendChild(pill);

      var titleCell = document.createElement('td');
      titleCell.textContent = memory.title;
      if (memory.contested) {
        var flag = document.createElement('span');
        flag.className = 'pill'; flag.style.color = token('bad');
        flag.style.marginLeft = '8px'; flag.textContent = 'contested';
        titleCell.appendChild(flag);
      }

      [layerCell, titleCell].forEach(function (cell) { tr.appendChild(cell); });
      [memory.importance, memory.ageDays + 'd', memory.edges].forEach(function (value) {
        var cell = document.createElement('td');
        cell.className = 'num';
        cell.textContent = text(value);
        tr.appendChild(cell);
      });

      tr.addEventListener('click', function () { select(memory); });
      rows.appendChild(tr);
    });
  }

  [q, layer, sort].forEach(function (control) {
    control.addEventListener('input', function () { focus = null; render(); });
  });
  render();

  // ---- health ----
  var health = document.getElementById('health');
  data.health.forEach(function (check) {
    var row = document.createElement('div');
    var name = document.createElement('span'); name.textContent = check.name;
    var status = document.createElement('span');
    status.className = 'st ' + (check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail');
    status.textContent = check.status.toUpperCase();
    var note = document.createElement('span'); note.textContent = check.detail;
    row.appendChild(name); row.appendChild(status); row.appendChild(note);
    health.appendChild(row);
  });

  if (data.truncated) {
    var warning = document.createElement('div');
    var label = document.createElement('span'); label.textContent = 'snapshot';
    var state = document.createElement('span'); state.className = 'st warn'; state.textContent = 'WARN';
    var note = document.createElement('span');
    var left = Object.keys(data.truncated.omitted || {})
      .filter(function (kind) { return data.truncated.omitted[kind] > 0; })
      .map(function (kind) { return data.truncated.omitted[kind] + ' ' + kind; });
    note.textContent = 'Showing ' + data.graph.nodes.length + ' of ' + data.truncated.nodes + ' nodes' +
      (left.length ? '; not drawn: ' + left.join(', ') : '') +
      '. Everything is still in the Memories tab. Narrow the graph with a path: dai-memory ui src/store';
    warning.appendChild(label); warning.appendChild(state); warning.appendChild(note);
    health.appendChild(warning);
  }
}());
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
