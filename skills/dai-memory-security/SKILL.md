---
name: dai-memory-security
description: "Use when reviewing code for injection, unsafe input handling or exposed endpoints, and before shipping anything that reads user input. Examples: \"is this safe from injection?\", \"where does user input end up?\", \"security review this\", \"which endpoints are exposed?\", \"can this path be reached from outside?\""
---

# Following untrusted input to where it can hurt

A security review by reading is a review of the lines you happened to open.
The question is not whether a line looks dangerous — it is whether anything a
stranger controls can reach it.

## When to use this

Before shipping a change that reads input from outside the process. When
reviewing a diff that touches a handler, a query, a shell call or a file path.
And whenever the user asks whether something is "safe".

## How to use it

1. `dai_memory_taint` for the repository: where untrusted input could reach
   something dangerous, through the call graph. **The reply states what the
   analysis cannot do — read that part, not only the findings.**
2. `dai_memory_explain` on one declaration or file: the findings it is the
   source of, the sink of, or merely on the path of. The third case is the one
   people misread as an accusation.
3. `dai_memory_pdg` inside a declaration that a finding lands in: every name,
   the lines that set it, the lines that read it, and which lines run only
   under a condition. A sanitiser behind an `if` is not a sanitiser.
4. `dai_memory_routes` for what this repository exposes, and
   `dai_memory_shape_check` for what is wrong with the routes themselves — a
   path declared twice, a parameter no handler mentions, a route with no
   indexed handler.
5. `dai_memory_api_impact` to see which endpoints answer through a declaration
   you are about to change.

## Reading the result honestly

**A finding is a reachable path, not a vulnerability.** The analysis says input
*could* arrive; it does not know your framework escapes it, or that the caller
is internal. Confirm before reporting, and say which you did.

**Silence is not safety.** No findings means no path the graph could follow.
Reflection, dynamic dispatch and anything assembled from strings are invisible
to it. Never report "no vulnerabilities" — report "no reachable path found by
this analysis", which is what you actually know.

**Taint needs the data-flow graph.** If the store was built without it, the
tool says so rather than returning an empty result. Check that line first.

## What to do with nothing

Say plainly what was searched and what it cannot see. A clean taint run is
evidence about the paths it followed, and nothing at all about the rest.
