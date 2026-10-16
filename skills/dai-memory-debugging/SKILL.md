---
name: dai-memory-debugging
description: "Use when tracing why something fails, how one piece reaches another, or where a value comes from. Examples: \"why is this null here?\", \"how does this ever get called?\", \"where is this set?\", \"trace from the handler to the database\", \"this error makes no sense\""
---

# Finding the path between a cause and a symptom

Most debugging time goes on one question: how did control get *here*. Reading
outward from the stack trace answers it slowly; the call graph answers it
directly, including the paths that do not appear in this particular trace.

## When to use this

When a failure is reported somewhere far from where it was caused. When a
value is wrong and the assignment is not obvious. When you are about to add
logging to find out who calls something — ask the graph instead.

## How to use it

1. `dai_memory_trace` from one declaration to another: the shortest path over
   calls. **With no path it tells you where the chain breaks**, which is
   usually the more useful answer.
2. `dai_memory_process` on the flow the symptom sits in: each step, its
   distance from the entry point, and the confidence of the call that reached
   it. A low-confidence step is a good place for the bug to hide.
3. `dai_memory_pdg` inside the declaration itself: every name, the lines that
   set it, the lines that read it, and which lines run only under a condition.
   This is how you find the assignment that only happens on one branch.
4. `dai_memory_context` for the surroundings: callers, callees, types either
   way, and what memory records about it.
5. `dai_memory_why` when the code looks deliberately odd. Code that looks
   arbitrary is the strongest signal that a reason existed and was lost.

## Reading the result honestly

**No path is a finding, not a failure.** It means the graph cannot connect
them — which either explains the bug, or tells you the connection is dynamic
and the graph cannot see it. Decide which before moving on.

**Confidence belongs to the edge.** A path assembled from unsure edges is a
hypothesis. Say so rather than presenting it as the route.

**The graph is a snapshot.** If `index.stale` is set, you are tracing the code
as it was at an earlier commit — which can itself explain a mismatch between
what you read and what ran.

## What to do with nothing

Report what you searched and where the chain broke. "No call path found
between A and B" is a real result and often the one that cracks it; "I could
not find anything" is not.
