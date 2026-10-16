---
name: dai-memory-cli
description: "Use to set up, refresh, inspect or clean the memory store from the command line, and when a tool reports the index is stale or missing. Examples: \"index this project\", \"the index is out of date\", \"set up memory here\", \"why is search returning nothing?\", \"remove the store\""
---

# Keeping the store current

Every other tool here is only as good as the index behind it. Most of what
looks like a broken tool is a store built before the code changed, or never
built at all.

## When to use this

The first time memory is used in a repository. After a branch switch or a
large merge. Whenever a tool reports `index.stale`, or an answer describes
code that is no longer there.

## How to use it

1. `dai-memory init` once per project: creates the store, scans, builds the
   viewer. Running it again rebuilds what a scan produces and **keeps recorded
   memories**; only `--fresh` removes those as well.
2. `dai-memory ingest` to refresh after changes. No paths means scan the
   project. `--force` re-reads files the scanner would skip.
3. `dai-memory status` to see what is indexed, from which commit, and whether
   that is still current. Run this before believing any other answer.
4. `dai-memory embed` when semantic search is weak — it embeds nodes missing a
   current vector. Without it, ranking rests on fewer branches.
5. `dai-memory ui` to open the viewer, `dai-memory map` for the graph as a
   tree or Mermaid.
6. `dai-memory group create|add` when several repositories make up one system,
   then `dai-memory contracts <group>` for which repository answers which call.
7. `dai-memory prune --older-than 90` to forget old, unreferenced episodic
   memories. `--dry-run` first.
8. `dai-memory clean --yes` removes this project's store. Nothing is removed
   without `--yes`, and this is not reversible.

## Reading the result honestly

**`status` is the first diagnostic, not the last resort.** A stale index
explains more wrong answers than every other cause combined.

**A scan is not a build.** `init --no-scan` makes an empty store. Search
against it returns nothing, truthfully, and that is easy to misread as "this
project has no memory".

**Large files are skipped.** `--max-file-size` has a default; a file above it
is absent from the graph, not broken. Check before concluding it was missed.

## What to do with nothing

If a query returns nothing, run `status` before drawing any conclusion. Report
the index state alongside the empty result — an empty answer from a stale or
unbuilt store says nothing about the code.
