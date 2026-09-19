# Code-intelligence roadmap

The DAI harness uses this layer as its memory and code-graph engine. It
currently also runs GitNexus for code intelligence, which is PolyForm
Noncommercial and cannot stay in a product meant to be sold. The decision
(2026-09-17) is to **build every capability GitNexus provides into this layer
first, and remove GitNexus only after that** — nothing the harness relies on is
dropped along the way.

Every capability is built from GitNexus's published tool interfaces — names,
arguments, what an answer means — and never from its source.

Each milestone lands here first, with tests, and is then brought into the
harness with `scripts/vendor/sync-dai-memory.mjs`. The two repositories change
together.

## Milestones

Ordered by what the harness leans on hardest. The commit gate calls
change-impact on every commit, and seven of its skills call `impact` and
`context`; those come first.

| # | Milestone | Tools and commands | State |
|---|---|---|---|
| M1 | Traversal core | `impact` (up/downstream, depth 1–3 with WILL BREAK / LIKELY AFFECTED / MAY NEED TESTING, confidence floor, risk level), `context` (callers, callees, base and derived types, file imports, memory about it), `trace` (shortest path between two symbols); ambiguous names answer with ranked candidates | **done** — CLI and MCP (`dai_memory_impact`, `dai_memory_context`, `dai_memory_trace`) |
| M2 | Execution flows | entry points, forward traces stored as processes; `query` grouped by process; processes in `context` and `impact`; `processes` and `process/{name}` resources | **done** — CLI and MCP (`dai_memory_query`, `dai_memory_processes`, `dai_memory_process`); the MCP resources themselves arrive with M5 |
| M3 | Change analysis | `detect_changes` (unstaged / staged / all / compare against a base ref: diff hunks → changed symbols → blast radius → affected processes → risk), `pr_review` (breaking changes, affected modules, reviewers); the harness gate switches to it | **done** in this layer -- CLI `detect-changes` and `review`, MCP `dai_memory_detect_changes` and `dai_memory_review`; the harness gate switches over at M10 |
| M4 | Rename | `rename` — graph-backed edits with confidence, text-search edits flagged separately, dry run by default, refuses an ambiguous target | **done** -- CLI `rename`, MCP `dai_memory_rename`; refuses a stale graph outright |
| M5 | Graph access and housekeeping | read-only `cypher` and the `schema` resource; `check` (circular imports and other invariants); paginated `list_repos`; `status`, `clean`; code communities and the `clusters` / `cluster/{name}` resources | next |
| M6 | API surface | route extraction across the common web frameworks; `route_map`, `shape_check`, `api_impact`, `tool_map` | planned |
| M7 | Program dependence and taint | per-function control flow, control dependence and reaching definitions; taint sources, sinks and sanitizers with function-level cross-function paths; `explain`, `pdg_query` | planned |
| M8 | Multi-repository groups | group configuration, a registry of HTTP contracts between repositories, `group_list`, `group_sync`, `trace` across a group | planned |
| M9 | Wiki | documentation generated from the graph and the memory, through an explicitly configured model provider — never one chosen by default | planned |
| M10 | Harness switch-over | the gate, MCP configuration, skills, installers and docs move to this layer; GitNexus is removed; the harness's older memory stores are retired | planned |

## Rules every milestone keeps

- An answer that could not be computed says so. An empty list means "nothing
  found", never "could not look".
- A confidence is reported with every inferred edge, and a risk level states
  what it was derived from.
- A tool that writes source files — `rename` — previews by default and applies
  only when asked.
- Tests for each capability run against real ingested repositories in this
  suite, and each fix shows the failing test before the passing one.
