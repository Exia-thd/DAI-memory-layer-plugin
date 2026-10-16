---
name: dai-memory-impact
description: "Use before editing or deleting a declaration, and before committing, to find what depends on it. Examples: \"what breaks if I change this?\", \"is it safe to delete this function?\", \"who calls this?\", \"review my changes before I push\", \"what does this diff actually affect?\""
---

# Finding out what a change reaches

The cost of a change is rarely in the lines you edit. It is in the callers you
did not know about, and those are exactly what a diff does not show you.

## When to use this

Before editing a function, class or method — not after. Before deleting
anything. And before committing, on the whole diff rather than one symbol.

Answer with the blast radius *before* making the edit, and say the risk level
out loud. A change nobody checked the reach of is a change nobody can size.

## How to use it

1. `dai_memory_impact` with the declaration you are about to touch. Use
   `direction: upstream` for what breaks if it changes, `downstream` for what
   it would take with it if removed.
2. An ambiguous name comes back as **candidates**. Pick one with `uid`, or
   narrow with `file`. Do not guess which candidate was meant.
3. `dai_memory_detect_changes` before committing: what the diff changes in
   *declarations* rather than lines, what depends on them, and the risk.
4. `dai_memory_review` to read a branch the way a reviewer wants it — what can
   break outside the files changed, and who has worked there before.
5. `dai_memory_api_impact` when the declaration sits behind an HTTP surface:
   which endpoints answer through it, and how many calls away.

## Reading the result honestly

**Risk is computed from the graph, not from judgement.** HIGH means many
dependents or a short path to many; it does not know that one of them is a
test and another is a payment path. Read the list, not only the badge.

**`minConfidence` hides nothing.** Edges below the threshold are *counted but
not followed*, so a small number next to a big count means the graph was
unsure, not that the reach is small.

**Tests are excluded unless asked for.** `includeTests` changes the answer;
when the question is "what will I have to update", you usually want them in.

**Stale index, stale radius.** If `index.stale` is set, the dependents listed
are the ones that existed at an older commit.

## What to do with nothing

No dependents can mean genuinely unused, or that the callers reach it in a way
the graph cannot follow — reflection, dynamic dispatch, a string in config.
Before calling code dead, say which of the two you ruled out.
