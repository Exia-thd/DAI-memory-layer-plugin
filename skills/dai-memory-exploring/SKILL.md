---
name: dai-memory-exploring
description: "Use when meeting a codebase or an area of it for the first time, or when a question is about how something works rather than where a string appears. Examples: \"how does login work?\", \"what does this service actually do?\", \"where does a request go after the route?\", \"walk me through the payment flow\", \"what are the main parts of this repo?\""
---

# Learning what a codebase does

Grep finds where a word appears. It cannot tell you what runs, in what order,
or which of forty matches is the one that matters. The code graph can, because
it was built from the syntax rather than from the text.

## When to use this

Before changing code in an area you have not worked in, and whenever the
question is *how does this work* rather than *where is this written*. Reach for
it instead of a broad grep: a search for `auth` across a repository is a list
of files, and a list of files is not an explanation.

## How to use it

1. `dai_memory_query` with the words you would use to describe the behaviour.
   It answers with the **execution flows** the answer runs in, not a file list,
   so you see the shape before the detail.
2. `dai_memory_processes` for the whole repository when you want its map: every
   entry point and what it reaches. `dai_memory_process` for one flow step by
   step, with each step's distance from the entry point.
3. `dai_memory_map` with a path prefix to get oriented in one directory: its
   files, declarations, calls, inheritance and imports.
4. `dai_memory_context` once a single declaration matters: what encloses it,
   its callers and callees, the types either way, and the memory about it.
5. `dai_memory_code_clusters` for an unfamiliar repository's shape — which
   parts talk to each other. (For groups of *memories* rather than code, that
   is `dai_memory_clusters`.)

## Reading the result honestly

**Confidence is on the edges, not on the answer.** A call the graph is unsure
about is still shown. Treat a low-confidence edge as a lead, not a fact.

**Check `index.stale`.** The graph describes the commit it was built from. If
the working tree has moved on, what you are reading is history — re-index
before concluding that something is absent.

**A flow is what the graph could follow.** Dynamic dispatch, reflection and
callbacks registered at runtime leave gaps. A flow that stops does not prove
the behaviour stops.

## What to do with nothing

An empty answer means the graph has no path, which is not the same as the
behaviour not existing. Say which tool you used and what it did not find,
rather than reporting that the feature is missing.
