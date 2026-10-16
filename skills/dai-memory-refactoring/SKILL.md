---
name: dai-memory-refactoring
description: "Use when renaming, extracting, splitting or moving a declaration, so the change follows the call graph instead of matching text. Examples: \"rename this function everywhere\", \"extract this into its own module\", \"split this class\", \"move this helper\", \"clean up this file\""
---

# Changing a shape without breaking what holds it

A rename done with find-and-replace is a bet that no other symbol shares the
name and that no caller spells it differently. The call graph knows which
occurrences are the declaration and which are a coincidence; text does not.

## When to use this

Any rename beyond a local variable. Any extraction or move that other code
imports. Whenever the alternative is a repository-wide text replacement.

**Never rename with find-and-replace.** It silently edits comments, strings,
unrelated symbols that share the name, and its own guard rails — a repo-wide
replace has rewritten the very list that was supposed to catch it.

## How to use it

1. `dai_memory_impact` first, on the declaration you are about to move or
   rename. Decide whether the change is worth its reach before starting.
2. `dai_memory_rename` with the declaration and the new name. It returns a
   **plan**: every site it would change, through the call graph. Read it.
3. Apply only when the plan is right — applying must be asked for explicitly.
   An ambiguous name is refused rather than guessed, and so is a graph older
   than the working tree.
4. `dai_memory_context` on anything the plan touches that surprised you: what
   encloses it, its members, callers and callees, and the memory about it.
5. `dai_memory_check` afterwards: import cycles, declarations now taking part
   in nothing, files that declare nothing indexed.

## Reading the result honestly

**The plan is the deliverable.** A plan that looks wrong means the graph
resolved a different declaration than you meant — fix the target, do not
apply and repair afterwards.

**`includeText` widens the net past the graph.** Comments and strings are text,
not references. Turning it on trades precision for reach; say which you chose.

**A refused rename is a result.** "Ambiguous" means two declarations answer to
that name and the tool will not pick for you. Pick with `uid`.

## What to do with nothing

If the plan is a single site, the symbol may genuinely be local — or the
callers reach it dynamically and the graph cannot see them. Check
`dai_memory_impact` before concluding the rename is trivial.
