---
name: dai-memory-guide
description: "Use to pick the right memory tool for a question, or when a question does not fit any of the others. Examples: \"which tool should I use for this?\", \"is the index up to date?\", \"what can this plugin do?\", \"query the store directly\", \"generate docs from the code\""
---

# Choosing the tool that answers the question

There are two graphs here and they answer different questions. The **memory
graph** holds decisions, errors and constraints — why the code is as it is.
The **code graph** holds declarations and the calls between them — what the
code does. Asking the wrong one returns an honest empty answer to a question
it was never holding.

## Which tool answers what

| The question | The tool |
|---|---|
| Why is this like this? Who decided? | `dai_memory_why`, `dai_memory_search` |
| What has this project already settled? | `dai_memory_constraints` |
| How does this work? What runs? | `dai_memory_query`, `dai_memory_processes` |
| What breaks if I change it? | `dai_memory_impact`, `dai_memory_detect_changes` |
| How does A reach B? | `dai_memory_trace` |
| Everything about one declaration | `dai_memory_context` |
| Inside one declaration | `dai_memory_pdg` |
| Can untrusted input get here? | `dai_memory_taint`, `dai_memory_explain` |
| Rename through the call graph | `dai_memory_rename` |
| What does this repo expose? | `dai_memory_routes`, `dai_memory_tool_map` |
| Several repositories as one system | `dai_memory_groups`, `dai_memory_contracts` |
| None of the above | `dai_memory_cypher` |

## How to use it

1. `dai_memory_status` first when an answer looks wrong: the commit the graph
   was built from, whether the working tree has moved on, the schema, and
   whether embeddings and the data-flow graph are present. Half of "the tool
   is broken" is an index built before the code changed.
2. `dai_memory_get` to read one memory node in full with its direct edges, and
   `dai_memory_neighbors` to walk out from it. Traversal is bidirectional, so
   asking from an error reaches the decision that resolved it.
3. `dai_memory_cypher` for a question no other tool answers — one read-only
   query. Write clauses and multiple statements are refused by design.
4. `dai_memory_wiki` to build documentation from the graph, the memory and the
   source. No model is called; with `check` it reports drift and writes nothing.

## Reading the result honestly

**Empty from the wrong graph means nothing.** Before reporting that a project
recorded no decisions, check you did not ask the code graph.

**Nothing here generates text.** `dai_memory_summarize` records a summary *you*
wrote. The tools report what is stored; they do not invent prose.

**Say which tool you used.** An answer whose source is not named cannot be
checked, and the person reading it has no way to tell measurement from guess.
