# Memory layer plugin

Project memory for Claude: it records **why** — decisions, the incidents that
prompted them, constraints, and the relationships between them — and retrieves
them when an agent needs the reasoning behind unfamiliar code.

> Tiếng Việt: [README_vn.md](README_vn.md)

It records what each file declares and what those declarations do to each other
— calls, inheritance, imports, across 29 languages — so a question about a
symbol has somewhere to anchor and somewhere to go next. The graph is not the
point; reaching the reasoning is. *What calls what* is how a decision recorded
on one function is found from the code that depends on it.

---

## What it does

```
$ dai-memory why src/billing/retry.ts

 1. [semantic] Cap declined-card retries at two
    docs/billing.md#L3-L8
    Chosen over exponential backoff because the processor counts attempts, not
    elapsed time. Two attempts stays under the fraud heuristic.

 2. [episodic] Merchant account flagged
    session:2026-09-01
    Three retries on a declined card tripped the processor fraud heuristic; the
    account was flagged for six hours.

fusion: bm25=3 semantic=2 recency=4 anchor=2
```

The second entry is the incident. The first is the decision that `RESOLVES` it.
Asking from either end reaches the other.

---

## Install

Requires Node 20.11+ and a git repository.

### As a Claude Code plugin

```
/plugin marketplace add Exia-thd/DAI-memory-layer-plugin
/plugin install dai-memory
```

Then, once, from the installed plugin directory:

```bash
node bin/setup.mjs
```

Installing a plugin copies the repository — it does not install dependencies,
compile TypeScript or download the embedding model, and this plugin needs all
three. `setup.mjs` does them and checks each one actually landed. Until it has
finished, the plugin refuses to run and session start says why, rather than
staying quiet: a plugin that looks installed and silently does nothing is the
worse failure.

Restart Claude Code afterwards so the MCP server starts. `.mcp.json` registers
it and `hooks/` wires it into the session; nothing else needs configuring.

### From a clone

```bash
node bin/setup.mjs                      # dependencies, build and model -- all three

node bin/dai-memory.mjs init            # store, scan, code graph, viewer
node bin/dai-memory.mjs search "why do we retry declined cards"
```

`init` is the whole setup: it scans the conventional places a project keeps
documentation and source, builds the code graph, and writes `.memory/ui.html` —
open that in a browser to see what it found.

**Installed means all three: dependencies, build, and the embedding model.**
`setup.mjs` does them in that order and stops with a reason at the first one
that fails; re-running it picks up where it stopped. There is no shortcut that
skips the model — `pnpm install && pnpm build` alone leaves a plugin that
refuses to run.

Until all three are in place:

- the MCP server does not start, and says what is missing;
- session start says it too, in every project;
- `search`, `why`, `write`, `ingest` and `merge` refuse, naming `setup.mjs` —
  they never download the model themselves, and never run without it;
- `doctor` still runs, and fails on the `embedding model` line.

**Already installed?** Re-running `setup.mjs` skips whatever is done — no
reinstall, no rebuild, no download; on an installed machine it takes a few
seconds. **After updating the plugin**, run it again: every build records what
it was built from (sources, manifests, lockfile), and a build of older code
refuses to run and says it is out of date rather than silently running the
previous version. Setup sees the same thing and rebuilds.

There is no fallback. There used to be one — lexical hash features, first
automatic and then selectable — and a store built with it answered every
question with something, just worse, indistinguishable from working until a
project's whole history sat in a vector space that cannot be compared with the
model's. The hash embedder remains only for the test suite.

Installing into a codebase that already exists is the case this is for, so
nothing about it assumes an empty repository.

A task-by-task guide, including what to automate and what not to, is in
[docs/usage.md](docs/usage.md).

---

## Commands

A task-by-task guide is in [docs/usage.md](docs/usage.md).

| Command | Purpose |
|---|---|
| `dai-memory init [paths...] [--fresh]` | Create the store, scan the project, build the code graph and the viewer. Run again to rebuild what a scan produces and keep what was recorded; `--fresh` removes recorded memory too |
| `dai-memory index <query>` | Titles only, ~15 tokens each — pick before you read |
| `dai-memory ingest [paths]` | Load files — no paths scans the project. Replaces what they produced before, reclaims what is gone, refreshes the viewer |
| `dai-memory search <query>` | Three-branch retrieval with a fusion report |
| `dai-memory why <file\|symbol> [--anchor-only]` | Decisions and constraints touching it — a bare symbol anchors on the declaration. `--anchor-only` skips the embedding model, which costs ~2.5 s |
| `dai-memory changes [--scope S]` | What memory records about the files you are about to commit |
| `dai-memory get <id>` | One node in full, with its edges |
| `dai-memory graph <id> --depth N` | Walk the memory graph |
| `dai-memory constraints` | What this project has already settled |
| `dai-memory conflicts` | Contradictions a person needs to resolve |
| `dai-memory map [path] [--format mermaid]` | The code graph: files, declarations, what calls what, and the memory about each |
| `dai-memory impact <symbol> [--direction D] [--depth N]` | What breaks if it changes: dependents by distance (d=1 WILL BREAK, d=2 LIKELY AFFECTED, d=3 MAY NEED TESTING), with confidence and a risk level |
| `dai-memory context <symbol>` | One declaration from every side: container, members, callers, callees, base and derived types, imports, memory |
| `dai-memory trace <from> <to>` | The shortest call path between two declarations, or where the chain breaks |
| `dai-memory query <words...>` | What answers these words, grouped by the execution flow it runs in |
| `dai-memory processes [--limit N]` | Every execution flow: an entry point, and what it reaches |
| `dai-memory process <name>` | One flow, step by step, with each step's distance from the entry |
| `dai-memory detect-changes [--scope S] [--base REF]` | What a diff changes in declarations: dependents, flows, risk, and what it could not see |
| `dai-memory review [--base REF]` | A branch as a reviewer wants it: what can break other files, which modules, who has worked there |
| `dai-memory rename <symbol> <new name> [--apply]` | Rename through the call graph. Other occurrences of the word are reported, not rewritten; nothing is written without `--apply` |
| `dai-memory routes` | The HTTP routes this repository declares, per framework, and what handles each |
| `dai-memory shape-check` | What is wrong with those routes: duplicates, unbound path parameters, no handler |
| `dai-memory api-impact <symbol>` | Which endpoints answer through a declaration |
| `dai-memory tools` | The MCP tools this repository declares |
| `dai-memory group list\|create\|add\|remove\|delete` | Repositories that make up one system |
| `dai-memory contracts <group>` | Which repository answers which HTTP call, and which calls nothing answers |
| `dai-memory taint [--depth N]` | Where untrusted input could reach something dangerous, through the call graph -- places worth reading, not a vulnerability report |
| `dai-memory explain <symbol\|file>` | What that says about one declaration or file |
| `dai-memory pdg <symbol>` | Inside one declaration: every name, where it is set, where it is read, what runs only under a condition |
| `dai-memory check [--fail-on S]` | Invariants over the code graph -- import cycles and the rest -- with what each rule examined |
| `dai-memory code-clusters [--min-size N]` | Communities in the call graph, named after the directory most of each lives in |
| `dai-memory cypher <query>` | One read-only query against the store. Writing clauses are refused, and a query with no LIMIT is given one |
| `dai-memory status` | What is indexed, from which commit, and whether the working tree has moved on |
| `dai-memory clean --yes` | Remove this project's store. Nothing goes without `--yes` |
| `dai-memory clusters` | Communities in the memory graph, with any stored summary |
| `dai-memory summarize <id> --body S` | Record a summary for a group, linked to its members |
| `dai-memory session start\|end` | Open or close a session, so writes record when they happened |
| `dai-memory write` / `dai-memory link` | Record a memory, or relate two |
| `dai-memory merge` | Fold queued session writes into the store |
| `dai-memory list` | Registered projects, with index freshness |
| `dai-memory ui [path] [--out FILE]` | Build a browser view: 3D graph, the store, and health |
| `dai-memory prune [--older-than N] [--dry-run]` | Forget old, unreferenced episodic memories |
| `dai-memory doctor` | What is actually working |
| `dai-memory serve` | MCP server on stdio |

---

## How retrieval works

Three branches, fused by reciprocal rank fusion at `k=60`, keyed on **node id**
rather than file path — one file can hold several decisions that disagree, and
collapsing them to the file would merge them.

```
query ├─► BM25 (posting rows in the store)     ─┐
      ├─► semantic (cosine ranked in-database) ─┼─► RRF k=60 ─► graph expansion
      └─► recency × importance                 ─┘
```

Each branch narrows to candidates before anything is loaded: keyword hits come
from one row per query term, similarity is ranked inside the database by
`array_cosine_similarity`, and only the nodes that survive fusion are read in
full. Nothing on this path reads the whole store, so the cost scales with the
query rather than with how much has been remembered.

Every result carries a `fusion` block:

```jsonc
{
  "results": [ /* ... */ ],
  "fusion": {
    "branches": { "bm25": 12, "semantic": 0, "recency": 20 },
    "degraded": ["semantic"],
    "reasons": { "semantic": "No node in this store carries an embedding yet." },
    "k": 60
  }
}
```

**This is the single most important design decision in the project.** A branch
that returns nothing and says nothing turns fusion into whichever branch still
works, and nobody finds out. The report distinguishes *ran and matched nothing*
from *could not run*, and names the reason. It is what an agent needs in order to
know how much weight the ranking deserves.

---

## Design constraints

Each one guards a failure that has actually been observed, and each has a test.

| # | Constraint |
|---|---|
| C1 | One store. No migration step between writing and reading. |
| C2 | One implementation per capability. |
| C3 | No swallowed errors. Every command exits non-zero with a reason. |
| C4 | Fusion declares its empty branches. |
| C5 | Queries are matched by term, never as a substring. |
| C6 | No decorative parameters. `depth` genuinely changes the traversal. |
| C7 | Anything writable is readable back through a path that is exercised. |
| C8 | Every import is a declared dependency. |
| C9 | No claiming a capability that is not implemented. |
| C10 | A reader never serves a snapshot from before the last write. |
| C11 | The write counter advances only after a durable commit, never before. |

C10 and C11 came out of measurement rather than from the plan. A read-only
LadybugDB handle is frozen at its open point and reports no error when it falls
behind; and because the counter that fixes that lives outside the database, the
order of committing and advancing it is a contract in its own right. Getting it
backwards would leave the guard asserting a falsehood, which is worse than not
having one. See [docs/m0-findings.md](docs/m0-findings.md).

### The rule behind all of them

The three worst bugs in this project's history have the same shape: a component
went missing, a `try/catch` or a `?? []` absorbed it, and the system carried on
at lower quality **emitting no signal at all**. Silent RRF decay when a branch
returned nothing; a keyword branch that became `undefined` and was patched to an
empty array; an AST chunker that never once ran.

So:

> **Anything that can be absent while the system keeps working must have a line
> in `capabilities`. There is no exception for "this one is always there".**

The AST chunker was the thing everyone was sure was always there.

```bash
node --test --test-concurrency=1 tests/*.test.js   # 119 tests
node packages/cli/dist/cli.js doctor
```

---

## Data model

Four layers — `semantic` (decisions, constraints), `episodic` (what happened),
`procedural` (sequences known to work), `artifact` (ingested content).

Six edge types, all of which mean something: `RESOLVES`, `SUPERSEDES`,
`CONTRADICTS`, `DERIVED_FROM`, `OCCURRED_IN`, `CONSTRAINS`. There is deliberately
no `relates_to`.

Every node carries a `source_ref` (`docs/billing.md#L3-L8`). A memory that cannot
be traced back cannot be checked, and will be believed anyway — so a chunk
without one is not written.

Nodes are superseded, never deleted. Episodic memories decay in ranking weight;
semantic ones do not. Decay demotes; it does not remove.

---

## Privacy and safety

- **Redaction runs before embedding.** Once text has been through an embedder the
  vector still carries the secret, and masking the source text afterwards changes
  nothing. There is a test for the ordering.
- **Everything is local.** The store lives in `.memory/` and is gitignored. The
  embedding model runs locally through ONNX; no text leaves the machine.
- **Memory does not cross projects.** The registry knows every project, so
  cross-repo queries are technically possible and deliberately not offered.
- **Automatic writes are off by default.** Reads are automatic; recording into a
  project's store is something the user opts into with
  `MEMORY_LAYER_AUTO_RECORD=1`.

---

## Known limits

- **Process startup still costs more than the work.** `memory --help` is 318 ms,
  of which 225 ms is node itself. The MCP SDK used to be loaded on every command
  and is now imported only by `serve`; the database binding loads on first use.
  What is left is node's own start, which a long-lived MCP server pays once and
  a CLI call pays every time.
- **`dai-memory list` is linear in projects.** Marginal cost measured 14.5 ms per
  project at five, 20.8 ms at fifty, despite a pool limit of eight: process
  spawn on Windows barely overlaps, so the pool buys close to nothing. Fifty
  projects take about 1.3 s. Usable, but not the concurrency the code implies.
- **Semantic search is still an exact scan.** There is no vector index on these
  platforms, so its cost grows with the number of embedded nodes even though the
  scan now happens inside the database.
- **The embedding cutoff is measured, not calibrated.** The default model is
  multilingual because an English-only one scored unrelated Vietnamese text
  *above* relevant Vietnamese text -- it ranked by language, not by subject, and
  no threshold separates that. The replacement separates with a margin four
  times wider at the same 384 dimensions. But the 0.75 cutoff comes from five
  queries against two documents: enough to reject a broken model, not enough to
  call the number calibrated. See `docs/m0-findings.md`.
- **Model weights cache in `<MEMORY_LAYER_HOME>/models`.** Not in the package
  directory, where the path ran to 279 characters under pnpm on Windows and the
  download failed as `File doesn't exist` -- which reads as a blocked network and
  was recorded as one. Override with `MEMORY_LAYER_MODEL_CACHE`.
- **Automatic recording stays off by default.** It records an episodic memory
  for every failed command, and most failures are typos. `dai-memory prune` exists
  now, so this is a decision rather than a trap — but turn it on when pruning is
  a habit, not before.
- **Summaries are written, never generated.** `dai-memory summarize` stores a
  summary the caller wrote and links it to the group members, so it survives the
  grouping being recomputed. Nothing in a read path calls a model. That is the
  line this project will not cross for a nicer name: retrieval over generated
  community summaries is a different system, and the one here is community
  detection with a place to put a summary somebody wrote.
- **No watch mode, on purpose.** A long-lived watcher would hold the store open
  to write, which is the reader-versus-writer collision this design avoids by
  keeping every write a short-lived process. `dai-memory ingest` is already
  incremental through `fileHashes`; a watcher would buy convenience at the cost
  of the property that makes concurrent sessions safe.
- **Clustering uses Louvain, not Leiden.** Louvain can produce a community that
  is internally disconnected; Leiden fixes that and is what comparable tools
  use. It has not bitten a real store yet, and swapping it is a dependency
  change nobody has needed.
- **The web target does not exist.** Sigma.js, the React front end and the
  LangChain agent are all unbuilt: the plan said not to start them before the
  CLI was finished, and that still holds. Visualisation is easy to build and
  easy to mistake for progress.
- **Embedding is single-threaded.** A worker pool is the obvious next step, but
  the model hub is unreachable from this environment, so the cost it would save
  has never been measured. Adding concurrency to an unmeasured bottleneck is how
  you get a slower program with a lock bug in it.
- **Journaled writes lag.** A write made while another process held the lock is
  recorded but not searchable until `dai-memory merge`. `doctor` reports the backlog.
- **On Windows, one writable open per process.** A LadybugDB path opened for
  writing cannot be opened for writing again in the same process, even after
  `close()`; the second open is refused as though another process held the lock,
  and the process it names is this one. Read-only handles take a shared lock and
  are unaffected, so search, `why` and the reader's reopen-after-write are not.

  A CLI command writes once and exits, so it never meets this. `dai-memory serve`
  does: the first write in a session commits and every later one is journaled,
  reported as `queued` with a note, and counted by `doctor` until `dai-memory merge`
  runs from another process. Holding one writable handle open for the life of
  the server removes the queueing, and was measured and rejected -- an abrupt
  exit then leaves the write-ahead log un-checkpointed and the store does not
  open again, which is a worse failure than a visible backlog. Journaling is the
  safer degradation, and it is the one that reports itself.

---

## Configuration

| Variable | Effect |
|---|---|
| `MEMORY_LAYER_MODEL_CACHE` | Where the model is cached (default `<MEMORY_LAYER_HOME>/models`) |
| `MEMORY_LAYER_EMBED_DEVICE` | Accelerator for the model, e.g. `dml`, `cuda`. Default `cpu`: a failed accelerator probe crashed the process at exit |
| `MEMORY_LAYER_DIMS` | Vector width at `init`. Fixed thereafter. |
| `MEMORY_LAYER_HOME` | Registry, logs and model cache (default `~/.memory`) |
| `MEMORY_LAYER_MODEL_CACHE` | Model weights, if they need to live elsewhere |
| `MEMORY_LAYER_OUTPUT_BUDGET` | Byte cap on MCP tool output (default 24000) |
| `MEMORY_LAYER_AUTO_RECORD` | `1` to let hooks record failed commands |
| `MEMORY_LAYER_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Dat Tran Huu.

The four tree-sitter grammars vendored in `packages/core/grammars/` are built by
their own maintainers and stay under their own MIT licences, with the text in
`packages/core/grammars/licenses/` and their provenance — version, commit,
SHA-256 — in that directory's README.
