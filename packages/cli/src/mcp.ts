import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LAYERS, EDGE_TYPES, ddl, readMeta, type Layer, type EdgeType, log } from '@memory-layer/core';
import * as api from './api.js';
import { isStale, storeDirOrThrow } from './project.js';

/**
 * MCP server over stdio.
 *
 * Nothing here may write to stdout except the protocol itself; diagnostics go to
 * the log file and stderr. A stray console.log corrupts the framing and the
 * failure looks like the server being broken rather than noisy.
 */

export const TOOLS = [
  {
    name: 'dai_memory_search',
    description:
      'Use to find what memory records about a question. Ranked, with a report of which ' +
      'retrieval branches contributed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in natural language.' },
        limit: { type: 'number', description: 'Maximum results (default 10).' },
        layers: {
          type: 'array',
          items: { type: 'string', enum: [...LAYERS] },
          description: 'Restrict to these memory layers.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'dai_memory_why',
    description:
      'Use before changing code you did not write: the decisions and constraints touching a ' +
      'file or symbol, and the errors they answered.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A file path or a symbol name.' },
        limit: { type: 'number' },
      },
      required: ['target'],
    },
  },
  {
    name: 'dai_memory_get',
    description: 'Use to read one memory node in full, with its direct edges.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'dai_memory_neighbors',
    description:
      'Use to walk out from one memory node. Traversal is bidirectional, so asking from an ' +
      'error reaches the decision that resolved it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        depth: { type: 'number', description: 'Hops to walk, 1-4 (default 2).' },
        edge_types: { type: 'array', items: { type: 'string', enum: [...EDGE_TYPES] } },
      },
      required: ['id'],
    },
  },
  {
    name: 'dai_memory_write',
    description:
      'Use when a decision, error, constraint or procedure should outlive the session. Include ' +
      'why it was chosen over the alternative; the reply names memories worth linking.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...LAYERS] },
        title: { type: 'string' },
        body: { type: 'string' },
        source_ref: {
          type: 'string',
          description: 'Where this came from, e.g. "docs/adr/0007.md#L10-L40" or "session:2026-09-08".',
        },
        file_path: { type: 'string' },
        importance: { type: 'number', description: '0-10.' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              type: { type: 'string', enum: [...EDGE_TYPES] },
              weight: { type: 'number' },
            },
            required: ['to', 'type'],
          },
        },
      },
      required: ['layer', 'title', 'body', 'source_ref'],
    },
  },
  {
    name: 'dai_memory_link',
    description: 'Use to connect two memory nodes with a typed relationship.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        type: { type: 'string', enum: [...EDGE_TYPES] },
        weight: { type: 'number' },
      },
      required: ['from', 'to', 'type'],
    },
  },
  {
    name: 'dai_memory_constraints',
    description: 'Use at the start of a task: what this project has already settled, most important first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'dai_memory_map',
    description:
      'Use to get oriented in unfamiliar code: files, declarations, calls, inheritance, imports ' +
      'and the memory about each. Narrow it with a path prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
        format: { type: 'string', enum: ['json', 'mermaid'] },
      },
    },
  },
  {
    name: 'dai_memory_impact',
    description:
      'Use before editing a function, class or method: what breaks, by distance, with edge ' +
      'confidence and a risk level. An ambiguous name returns candidates to pick with uid.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A name, `Class.method`, or `file:qualified`.' },
        uid: { type: 'string', description: 'Exact declaration id, from a candidate list.' },
        file: { type: 'string', description: 'Narrow the name to files ending with this path.' },
        direction: { type: 'string', enum: ['upstream', 'downstream'] },
        maxDepth: { type: 'number', description: '1-5, default 3.' },
        minConfidence: { type: 'number', description: '0-1; edges below it are counted, not followed.' },
        includeTests: { type: 'boolean', description: 'List test declarations too (default false).' },
      },
    },
  },
  {
    name: 'dai_memory_context',
    description:
      'Use for one declaration in full: what encloses it, its members, callers, callees, types ' +
      'either way, its file imports and importers, and the memory about it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        uid: { type: 'string' },
        file: { type: 'string' },
      },
    },
  },
  {
    name: 'dai_memory_trace',
    description:
      'Use to see how one declaration reaches another: the shortest path over calls. With no ' +
      'path it says where the chain breaks.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        from_file: { type: 'string' },
        to_file: { type: 'string' },
        from_uid: { type: 'string' },
        to_uid: { type: 'string' },
        maxDepth: { type: 'number', description: '1-30, default 10.' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_query',
    description:
      'Use to ask the code graph in words and get the execution flows an answer runs in rather ' +
      'than a list of files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: '1-200, default 20.' },
        includeTests: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dai_memory_processes',
    description:
      'Use to learn what a codebase does before changing it: every execution flow, from its ' +
      'entry point.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, includeTests: { type: 'boolean' } },
    },
  },
  {
    name: 'dai_memory_process',
    description:
      'Use for one execution flow step by step, with each step distance from the entry point ' +
      'and the confidence of the call that reached it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, includeTests: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'dai_memory_detect_changes',
    description:
      'Use before committing: what the current diff changes in declarations rather than lines, ' +
      'what depends on them, the flows through them, and the risk.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'staged (default), working, or compare.' },
        base: { type: 'string', description: 'The ref to compare against when scope is compare.' },
        maxDepth: { type: 'number', description: '1-3, default 2.' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_review',
    description:
      'Use to read a branch as a reviewer wants it: what can break outside the files changed, ' +
      'which modules it lands in, and who has worked there before.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'The ref this branch is compared against. Default HEAD.' },
        maxDepth: { type: 'number' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_rename',
    description:
      'Use to rename a declaration through the call graph. Shows a plan; apply must be asked ' +
      'for. Refuses an ambiguous name, or a graph older than the working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        uid: { type: 'string' },
        file: { type: 'string' },
        to: { type: 'string' },
        apply: { type: 'boolean', description: 'Write the edits. Default false.' },
        includeText: { type: 'boolean', description: 'Also rewrite occurrences the graph cannot vouch for.' },
        includeTests: { type: 'boolean' },
      },
      required: ['to'],
    },
  },
  {
    name: 'dai_memory_wiki',
    description:
      'Use to build documentation from the code graph, the recorded memory and the source. No ' +
      'model is called. With check it reports drift and writes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Where to write. Default: the store\'s wiki directory.' },
        check: { type: 'boolean', description: 'Report drift and write nothing.' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_groups',
    description:
      'Use to list the repository groups on this machine, each the projects that make up one ' +
      'system.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dai_memory_contracts',
    description:
      'Use to see which repository in a group answers which HTTP call, and which calls nothing ' +
      'in the group answers.',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string' }, includeTests: { type: 'boolean' } },
      required: ['group'],
    },
  },
  {
    name: 'dai_memory_taint',
    description:
      'Use to find where untrusted input could reach something dangerous, through the call ' +
      'graph. The reply states what the analysis cannot do.',
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: { type: 'number', description: '0-6 calls from source to sink, default 3.' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_explain',
    description:
      'Use for what the taint analysis says about one declaration or file: the findings it is ' +
      'the source of, the sink of, or on the path of.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A declaration name.' },
        path: { type: 'string', description: 'A file path instead of a name.' },
        uid: { type: 'string' },
        file: { type: 'string' },
        maxDepth: { type: 'number' },
      },
    },
  },
  {
    name: 'dai_memory_pdg',
    description:
      'Use to look inside one declaration: every name, the lines that set it, the lines that ' +
      'read it, and which lines run only under a condition.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, uid: { type: 'string' }, file: { type: 'string' } },
    },
  },
  {
    name: 'dai_memory_routes',
    description: 'Use to list the HTTP routes this repository declares and the declaration each sits in.',
    inputSchema: { type: 'object', properties: { includeTests: { type: 'boolean' } } },
  },
  {
    name: 'dai_memory_shape_check',
    description:
      'Use to find what is wrong with the routes themselves: a path declared twice, a path ' +
      'parameter no handler mentions, a route with no indexed handler.',
    inputSchema: { type: 'object', properties: { includeTests: { type: 'boolean' } } },
  },
  {
    name: 'dai_memory_api_impact',
    description:
      'Use before changing something a service exposes: which endpoints answer through a ' +
      'declaration, and how many calls away each is.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        uid: { type: 'string' },
        file: { type: 'string' },
        maxDepth: { type: 'number', description: '1-8, default 5.' },
        includeTests: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dai_memory_tool_map',
    description:
      'Use to list the MCP tools this repository declares, where each is defined and how it was ' +
      'recognised.',
    inputSchema: { type: 'object', properties: { includeTests: { type: 'boolean' } } },
  },
  {
    name: 'dai_memory_check',
    description:
      'Use to run invariants over the code graph: import cycles, declarations that take part in ' +
      'nothing, files that declare nothing indexed.',
    inputSchema: { type: 'object', properties: { includeTests: { type: 'boolean' }, examples: { type: 'number' } } },
  },
  {
    name: 'dai_memory_code_clusters',
    description:
      'Use to learn the shape of an unfamiliar repository: communities in the call graph. For ' +
      'the memory graph use dai_memory_clusters.',
    inputSchema: {
      type: 'object',
      properties: { minSize: { type: 'number' }, limit: { type: 'number' }, includeTests: { type: 'boolean' } },
    },
  },
  {
    name: 'dai_memory_cypher',
    description:
      'Use for a question no other tool answers: one read-only Cypher query against the store. ' +
      'Write clauses and several statements at once are refused.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'dai_memory_status',
    description:
      'Use to check what is indexed here: the commit the graph was built from, whether the ' +
      'working tree has moved on, the schema, the embedding and the graph size.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dai_memory_clusters',
    description:
      'Use for a broad question about an area rather than one symbol: groups of related ' +
      'memories. For the call graph use dai_memory_code_clusters.',
    inputSchema: { type: 'object', properties: { min_size: { type: 'number' } } },
  },
  {
    name: 'dai_memory_summarize',
    description:
      'Use to record a summary you wrote for a group from dai_memory_clusters. Read the members ' +
      'first; nothing here generates text.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: { type: 'number' },
        body: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['cluster_id', 'body'],
    },
  },
  {
    name: 'dai_memory_changes',
    description:
      'Use before committing: what memory already records about the files this change touches, ' +
      'including the files with nothing recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['staged', 'working', 'compare'] },
        base_ref: { type: 'string' },
      },
    },
  },
  {
    name: 'dai_memory_conflicts',
    description:
      'Use before recording a decision: contradictions between recorded decisions that a person ' +
      'needs to settle.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * Workflows, for any client rather than one.
 *
 * `commands/*.md` is a Claude Code file: another MCP client never sees it, so the
 * same workflow had to be re-typed by whoever used one. These are the protocol's
 * own form of the same thing, and they are the only place a multi-step routine is
 * written down once.
 *
 * Each one names the tools to call and what to do with the answer. None of them
 * calls a tool itself: a prompt is text handed to the model, and the model decides.
 */
export const PROMPTS = [
  {
    name: 'memory_search',
    description: 'Use to search project memory and report what is recorded, including what is stale.',
    arguments: [{ name: 'query', description: 'What you want to know.', required: true }],
    text: (args: Record<string, string>) => [
      `Search this project's memory for: ${args.query ?? ''}`,
      '',
      'Use the `dai_memory_search` tool. Then report back:',
      '',
      '1. The matching memories, each with its `source_ref` and layer.',
      '2. Any entry marked `stale`, flagged as such.',
      '3. The `fusion` block if any branch is `degraded` -- the reader should know',
      '   when a ranking rests on fewer signals than usual.',
      '',
      'If nothing matches, say that nothing is recorded, rather than concluding that',
      'nothing exists.',
    ].join('\n'),
  },
  {
    name: 'memory_why',
    description: 'Use to explain why a file or symbol is the way it is, from the recorded decisions.',
    arguments: [{ name: 'target', description: 'A file path or a symbol name.', required: true }],
    text: (args: Record<string, string>) => [
      `Explain the reasoning behind: ${args.target ?? ''}`,
      '',
      '1. Call `dai_memory_why` with that file path or symbol.',
      '2. Lead with the decisions (`semantic`) and the reason each was chosen over its',
      '   alternative. Follow with the incidents (`episodic`) that prompted them.',
      '3. Use `dai_memory_neighbors` on any decision worth tracing, to pick up what it',
      '   `RESOLVES` or what `SUPERSEDES` it.',
      '4. Cite the `source_ref` for every claim.',
      '',
      'If the result carries `index.stale`, or entries are marked stale, say so: the',
      'store describes what was true when it was recorded, and the working tree is the',
      'authority on what is true now.',
    ].join('\n'),
  },
  {
    name: 'memory_before_commit',
    description: 'Use before committing, to check a change against what memory and the code graph already record.',
    arguments: [
      { name: 'scope', description: 'staged (default), working, or compare.', required: false },
    ],
    text: (args: Record<string, string>) => {
      const scope = args.scope ?? 'staged';
      return [
        `Check this change before it is committed. Scope: ${scope}.`,
        '',
        `1. \`dai_memory_changes\` with scope ${scope}: what memory already records about the`,
        '   files being changed. Files with nothing recorded are reported too -- say so',
        '   rather than reading silence as agreement.',
        `2. \`dai_memory_detect_changes\` with scope ${scope}: what the diff changes in`,
        '   declarations, what depends on them, and the risk.',
        '3. `dai_memory_conflicts`: contradictions a person still has to settle.',
        '',
        'Report anything the change contradicts, and name the `source_ref` of each',
        'recorded decision it touches. If the index is stale, say that first: a stale',
        'graph cannot rule anything out.',
      ].join('\n');
    },
  },
];

export async function serve(): Promise<void> {
  const server = new Server(
    { name: 'memory-layer', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Resources are the whole-repository answers: what this codebase is, what
  // runs in it, and how it is grouped. A client reads them once to orient
  // itself rather than asking a tool the same question every turn.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listResources() }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      const contents = await readResource(uri);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(contents, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('error', `resource ${uri} failed: ${message}`);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ error: message }, null, 2),
        }],
      };
    }
  });

  // Prompts carry the multi-step routines. Listing them is cheap; the body is
  // fetched only when one is asked for, so an unused workflow costs nothing.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = PROMPTS.find((entry) => entry.name === request.params.name);
    if (!prompt) throw new Error(`no such prompt: ${request.params.name}`);
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    const missing = (prompt.arguments ?? [])
      .filter((argument) => argument.required && !args[argument.name])
      .map((argument) => argument.name);
    // A prompt rendered with a hole in it reads like a question about nothing, so
    // the missing argument is named instead.
    if (missing.length > 0) throw new Error(`${prompt.name} needs: ${missing.join(', ')}`);
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      const payload = await dispatch(name, args);
      return { content: [{ type: 'text', text: budgeted(name, payload) }] };
    } catch (err) {
      // The error reaches the agent as an error, not as an empty result that reads
      // like "there is nothing recorded about this".
      const message = err instanceof Error ? err.message : String(err);
      log('error', `tool ${name} failed`, err);
      return {
        content: [{ type: 'text', text: `dai_memory_error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

/**
 * The point of this layer is to spend less of the agent's context, not more.
 *
 * A tool that answers with a megabyte of JSON has cost more than the grep it
 * replaced. So results are capped -- and when the cap bites, the reply says so.
 * A silently truncated list reads as a complete one, which is the whole failure
 * this project keeps finding in other people's code.
 */
export const OUTPUT_BUDGET_BYTES = Number(process.env.MEMORY_LAYER_OUTPUT_BUDGET ?? 24_000);

/** Arrays are trimmed before anything else: they are where the size lives. */
export function budgeted(tool: string, payload: unknown): string {
  const full = JSON.stringify(payload, null, 2);
  if (full.length <= OUTPUT_BUDGET_BYTES) return full;

  const trimmed = trimArrays(payload, OUTPUT_BUDGET_BYTES);
  const text = JSON.stringify(trimmed.value, null, 2);

  // Nothing dropped, and still over: the size is in one long value, not in a
  // list. Saying "0 items were dropped" there described a trim that did not
  // happen and left the reader to work out why the reply was still oversized.
  const notice = trimmed.dropped === 0
    ? `

dai_memory_oversized: ${tool} produced ${full.length} bytes, over the ` +
      `${OUTPUT_BUDGET_BYTES}-byte budget, and none of it is in a list that could be ` +
      'shortened -- it is returned whole. Narrow the query, or raise MEMORY_LAYER_OUTPUT_BUDGET.'
    : `

dai_memory_truncated: ${tool} produced ${full.length} bytes, over the ` +
      `${OUTPUT_BUDGET_BYTES}-byte budget. ${trimmed.dropped} item(s) were dropped from ` +
      'the end of the longest list. Narrow the query, or raise MEMORY_LAYER_OUTPUT_BUDGET.';
  return text + notice;
}

function trimArrays(payload: unknown, budget: number): { value: unknown; dropped: number } {
  if (Array.isArray(payload)) {
    const kept: unknown[] = [];
    let size = 2;
    for (const item of payload) {
      const piece = JSON.stringify(item, null, 2)?.length ?? 0;
      if (size + piece > budget && kept.length > 0) break;
      kept.push(item);
      size += piece + 2;
    }
    return { value: kept, dropped: payload.length - kept.length };
  }

  if (payload && typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    // Spend the budget on the longest array; the scalar fields around it are
    // the part the agent needs to interpret whatever is left.
    const longest = entries
      .filter(([, value]) => Array.isArray(value))
      .sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)[0];
    if (!longest) return { value: payload, dropped: 0 };

    const others = JSON.stringify(
      Object.fromEntries(entries.filter(([key]) => key !== longest[0])),
      null,
      2,
    ).length;
    const trimmed = trimArrays(longest[1], Math.max(budget - others, 512));
    return {
      value: { ...(payload as Record<string, unknown>), [longest[0]]: trimmed.value },
      dropped: trimmed.dropped,
    };
  }

  return { value: payload, dropped: 0 };
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'dai_memory_search': {
      const result = await api.runSearch(String(args.query ?? ''), {
        limit: numeric(args.limit),
        layers: args.layers as Layer[] | undefined,
      });
      return withFreshness(result);
    }

    case 'dai_memory_why': {
      const result = await api.runWhy(String(args.target ?? ''), { limit: numeric(args.limit) });
      return withFreshness(result);
    }

    case 'dai_memory_get': {
      const found = await api.runGet(String(args.id ?? ''));
      if (!found) throw new Error(`No such memory node: ${args.id}`);
      return found;
    }

    case 'dai_memory_neighbors':
      return api.runNeighbors(String(args.id ?? ''), {
        depth: numeric(args.depth),
        edgeTypes: args.edge_types as EdgeType[] | undefined,
      });

    case 'dai_memory_write': {
      const result = await api.runWrite({
        layer: args.layer as Layer,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        sourceRef: String(args.source_ref ?? ''),
        filePath: args.file_path ? String(args.file_path) : undefined,
        importance: numeric(args.importance),
        links: args.links as { to: string; type: EdgeType; weight?: number }[] | undefined,
      });
      return {
        ...result,
        note: result.queued
          ? 'Another process held the write lock, so this was queued to the session journal. ' +
            'It is recorded but will not appear in search until `dai-memory merge` runs.'
          : undefined,
        // Said in words, because an agent reads the reply and a bare array of
        // ids reads as noise. The graph branch only retrieves through edges
        // somebody recorded, so the moment just after a write -- when the
        // reasoning is still in hand -- is the one moment linking is cheap.
        suggestion: result.related.length > 0
          ? `${result.related.length} existing memor${result.related.length === 1 ? 'y is' : 'ies are'} ` +
            'close to this one. If any of them bears on this decision, call dai_memory_link -- ' +
            'search retrieves one hop along those links, so an unlinked decision is found ' +
            'only by its own wording.'
          : undefined,
      };
    }

    case 'dai_memory_link': {
      const result = await api.runLink(String(args.from ?? ''), String(args.to ?? ''), args.type as EdgeType, {
        weight: numeric(args.weight),
      });
      // Reported the way dai_memory_write reports it. An edge that went to the
      // journal is recorded but not yet traversable, and saying so is the
      // difference between a queued write and one the caller thinks landed.
      return {
        ...result,
        note: result.queued
          ? 'Another process held the write lock, so this edge was queued to the session journal. ' +
            'It is recorded but will not be traversable until `dai-memory merge` runs.'
          : undefined,
      };
    }

    case 'dai_memory_constraints':
      return { constraints: await api.runConstraints({ limit: numeric(args.limit) }) };

    case 'dai_memory_map': {
      const { runMap, formatMapMermaid } = await import('./map.js');
      const map = await runMap({ prefix: args.prefix as string | undefined });
      return args.format === 'mermaid' ? { mermaid: formatMapMermaid(map) } : map;
    }

    case 'dai_memory_impact': {
      const { runImpact } = await import('./code.js');
      const direction = args.direction === 'downstream' ? 'downstream' : 'upstream';
      return runImpact(
        { name: optionalString(args.target), uid: optionalString(args.uid), file: optionalString(args.file) },
        {
          direction,
          maxDepth: numeric(args.maxDepth),
          minConfidence: numeric(args.minConfidence),
          includeTests: args.includeTests === true,
        },
      );
    }

    case 'dai_memory_context': {
      const { runContext } = await import('./code.js');
      return runContext({ name: optionalString(args.name), uid: optionalString(args.uid), file: optionalString(args.file) });
    }

    case 'dai_memory_trace': {
      const { runTrace } = await import('./code.js');
      return runTrace(
        { name: optionalString(args.from), uid: optionalString(args.from_uid), file: optionalString(args.from_file) },
        { name: optionalString(args.to), uid: optionalString(args.to_uid), file: optionalString(args.to_file) },
        { maxDepth: numeric(args.maxDepth), includeTests: args.includeTests === true },
      );
    }

    case 'dai_memory_query': {
      const { runQuery } = await import('./code.js');
      if (typeof args.query !== 'string' || !args.query.trim()) {
        throw new Error('dai_memory_query needs a query.');
      }
      return runQuery(args.query, { limit: numeric(args.limit), includeTests: args.includeTests === true });
    }

    case 'dai_memory_processes': {
      const { runProcesses } = await import('./code.js');
      return runProcesses({ limit: numeric(args.limit), includeTests: args.includeTests === true });
    }

    case 'dai_memory_process': {
      const { runProcess } = await import('./code.js');
      if (typeof args.name !== 'string' || !args.name.trim()) {
        throw new Error('dai_memory_process needs the name of an execution flow.');
      }
      return runProcess(args.name, { includeTests: args.includeTests === true });
    }

    case 'dai_memory_detect_changes': {
      const { runDetectChanges } = await import('./code.js');
      const scope = typeof args.scope === 'string' ? args.scope : 'staged';
      if (!['staged', 'working', 'compare'].includes(scope)) {
        throw new Error('dai_memory_detect_changes scope is staged, working or compare.');
      }
      return runDetectChanges({
        scope: scope as 'staged' | 'working' | 'compare',
        baseRef: optionalString(args.base),
        maxDepth: numeric(args.maxDepth),
        includeTests: args.includeTests === true,
      });
    }

    case 'dai_memory_review': {
      const { runReview } = await import('./code.js');
      return runReview({
        baseRef: optionalString(args.base),
        maxDepth: numeric(args.maxDepth),
        includeTests: args.includeTests === true,
      });
    }

    case 'dai_memory_rename': {
      const { runRename } = await import('./code.js');
      if (typeof args.to !== 'string' || !args.to.trim()) throw new Error('dai_memory_rename needs the new name in `to`.');
      if (!optionalString(args.target) && !optionalString(args.uid)) {
        throw new Error('dai_memory_rename needs a target name or uid.');
      }
      return runRename(
        { name: optionalString(args.target), uid: optionalString(args.uid), file: optionalString(args.file) },
        args.to,
        { apply: args.apply === true, includeText: args.includeText === true, includeTests: args.includeTests === true },
      );
    }

    case 'dai_memory_wiki': {
      const { runWiki } = await import('./code.js');
      return runWiki({ out: optionalString(args.out), check: args.check === true, includeTests: args.includeTests === true });
    }

    case 'dai_memory_groups': {
      const { readGroups } = await import('./groups.js');
      return { groups: readGroups() };
    }

    case 'dai_memory_contracts': {
      const { runContracts } = await import('./code.js');
      if (typeof args.group !== 'string' || !args.group.trim()) {
        throw new Error('dai_memory_contracts needs a group name.');
      }
      return runContracts(args.group, { includeTests: args.includeTests === true });
    }

    case 'dai_memory_taint': {
      const { runTaint } = await import('./code.js');
      return runTaint({ maxDepth: numeric(args.maxDepth), includeTests: args.includeTests === true });
    }

    case 'dai_memory_explain': {
      const { runExplain } = await import('./code.js');
      const path = optionalString(args.path);
      if (!path && !optionalString(args.target) && !optionalString(args.uid)) {
        throw new Error('dai_memory_explain needs a target name, uid or path.');
      }
      return runExplain(
        { name: optionalString(args.target), uid: optionalString(args.uid), file: optionalString(args.file), path },
        { maxDepth: numeric(args.maxDepth) },
      );
    }

    case 'dai_memory_pdg': {
      const { runPdg } = await import('./code.js');
      if (!optionalString(args.target) && !optionalString(args.uid)) {
        throw new Error('dai_memory_pdg needs a target name or uid.');
      }
      return runPdg({
        name: optionalString(args.target),
        uid: optionalString(args.uid),
        file: optionalString(args.file),
      });
    }

    case 'dai_memory_routes': {
      const { runRouteMap } = await import('./code.js');
      return runRouteMap({ includeTests: args.includeTests === true });
    }

    case 'dai_memory_shape_check': {
      const { runShapeCheck } = await import('./code.js');
      return runShapeCheck({ includeTests: args.includeTests === true });
    }

    case 'dai_memory_api_impact': {
      const { runApiImpact } = await import('./code.js');
      if (!optionalString(args.target) && !optionalString(args.uid)) {
        throw new Error('dai_memory_api_impact needs a target name or uid.');
      }
      return runApiImpact(
        { name: optionalString(args.target), uid: optionalString(args.uid), file: optionalString(args.file) },
        { maxDepth: numeric(args.maxDepth), includeTests: args.includeTests === true },
      );
    }

    case 'dai_memory_tool_map': {
      const { runToolMap } = await import('./code.js');
      return runToolMap({ includeTests: args.includeTests === true });
    }

    case 'dai_memory_check': {
      const { runCheck } = await import('./code.js');
      return runCheck({ includeTests: args.includeTests === true, examples: numeric(args.examples) });
    }

    case 'dai_memory_code_clusters': {
      const { runCodeClusters } = await import('./code.js');
      return runCodeClusters({
        minSize: numeric(args.minSize),
        limit: numeric(args.limit),
        includeTests: args.includeTests === true,
      });
    }

    case 'dai_memory_cypher': {
      const { runCypher } = await import('./code.js');
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('dai_memory_cypher needs a query.');
      return runCypher(args.query, { limit: numeric(args.limit) });
    }

    case 'dai_memory_status': {
      const { runStatus } = await import('./code.js');
      return runStatus();
    }

    case 'dai_memory_clusters':
      return { clusters: await api.runClusters() };

    case 'dai_memory_summarize': {
      if (typeof args.cluster_id !== 'number' || typeof args.body !== 'string') {
        throw new Error('dai_memory_summarize needs cluster_id and body.');
      }
      return await api.runSummarize(args.cluster_id, args.body, {
        title: args.title as string | undefined,
      });
    }

    case 'dai_memory_changes':
      return await api.runChanges({
        scope: args.scope as 'staged' | 'working' | 'compare' | undefined,
        baseRef: args.base_ref as string | undefined,
      });

    case 'dai_memory_conflicts':
      return { conflicts: await api.runConflicts() };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Attaches an index-freshness note.
 *
 * Memory describes what was true when it was recorded. Handing an agent results
 * from a store built several commits ago, with nothing saying so, is how a
 * memory layer turns into a confident liar.
 */
function withFreshness<T extends object>(result: T): T & { index?: object } {
  try {
    const state = isStale(storeDirOrThrow());
    if (!state.stale) return result;
    return {
      ...result,
      index: {
        stale: true,
        indexedAt: state.indexed,
        head: state.head,
        note: 'This store was built at an older commit. Treat results as context, not as current state, and re-verify against the working tree.',
      },
    };
  } catch {
    return result;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The resources this server offers, named after the project they describe.
 *
 * `dai-memory://<project>/context` is the orientation one: what this codebase
 * is, how big, when it was indexed. The others are the whole-repository
 * answers that a tool call would otherwise repeat every turn.
 */
async function listResources(): Promise<Array<{ uri: string; name: string; description: string; mimeType: string }>> {
  const { runStatus } = await import('./code.js');
  const status = await runStatus();
  const project = status.project.name;
  const resource = (path: string, name: string, description: string) => ({
    uri: `dai-memory://${project}/${path}`,
    name,
    description,
    mimeType: 'application/json',
  });
  return [
    resource('context', `${project}: what this is`, 'The project, the commit its graph was built from, whether that is still current, and how big the graph is.'),
    resource('processes', `${project}: execution flows`, 'Every execution flow: an entry point and what it reaches, with the rule that found the entry points.'),
    resource('clusters', `${project}: code clusters`, 'Communities in the call graph, named after the directory most of each lives in.'),
    resource('memory-clusters', `${project}: memory clusters`, 'Communities in the memory graph, with any summary somebody recorded for them.'),
    resource('taint', `${project}: untrusted input`, 'Where untrusted input could reach something dangerous, with what the analysis does not claim.'),
    resource('routes', `${project}: HTTP surface`, 'Every route this repository declares, the declaration each sits in, and which frameworks were looked for.'),
    resource('check', `${project}: invariants`, 'Import cycles and the other invariants, with what each rule examined.'),
    resource('schema', `${project}: graph schema`, 'The node and relationship types in the store, for writing a Cypher query against it.'),
  ];
}

/**
 * The schema, read out of the DDL the store was created with.
 *
 * Written by hand it would be a second source of truth, and the first thing to
 * go stale: this file said `filePath` while the store has `file_path`, and a
 * query written from it fails with "cannot find property". Derived, it cannot
 * drift.
 */
function graphSchema(): unknown {
  const statements = ddl(readMeta(storeDirOrThrow()).dimensions);
  const nodes: Record<string, string[]> = {};
  const relationships: Record<string, { from: string; to: string; properties: string[] }> = {};

  for (const statement of statements) {
    const node = /CREATE NODE TABLE (?:IF NOT EXISTS )?(\w+)\(([\s\S]*)\)/i.exec(statement);
    if (node) {
      nodes[node[1]!] = columnsOf(node[2]!);
      continue;
    }
    const rel = /CREATE REL TABLE (?:IF NOT EXISTS )?(\w+)\(([\s\S]*)\)/i.exec(statement);
    if (rel) {
      const body = rel[2]!;
      const ends = /FROM (\w+) TO (\w+)/i.exec(body);
      relationships[rel[1]!] = {
        from: ends?.[1] ?? 'unknown',
        to: ends?.[2] ?? 'unknown',
        properties: columnsOf(body),
      };
    }
  }

  return {
    nodes,
    relationships,
    notes: [
      'Containment is not an edge: a member is its container id plus a dotted name, so `Symbol:a.ts:Class.method` is inside `Symbol:a.ts:Class`.',
      'CALLS and INHERITS carry a confidence label, not a number. The scores used for ranking are type 1, file 0.95, receiver 0.9, import 0.85, unique 0.7.',
      'Queries through dai_memory_cypher are read-only, one statement at a time, and get a LIMIT if they do not have one.',
    ],
  };
}

/** Column names from a table body, leaving out the key and edge declarations. */
function columnsOf(body: string): string[] {
  return body.split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name && !/^(primary|from|to)$/i.test(name));
}

async function readResource(uri: string): Promise<unknown> {
  const match = /^dai-memory:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error(`not a resource of this server: ${uri}`);
  const path = match[2]!;
  const code = await import('./code.js');

  if (path === 'context') return code.runStatus();
  if (path === 'processes') return code.runProcesses({ limit: 200 });
  if (path === 'clusters') return code.runCodeClusters({ limit: 50 });
  if (path === 'memory-clusters') return { clusters: await api.runClusters() };
  if (path === 'taint') return code.runTaint();
  if (path === 'routes') return code.runRouteMap();
  if (path === 'check') return code.runCheck();
  if (path === 'schema') return graphSchema();

  const process = /^process\/(.+)$/.exec(path);
  if (process) return code.runProcess(decodeURIComponent(process[1]!));

  throw new Error(`no such resource: ${path}. This server offers context, processes, process/<name>, clusters, memory-clusters, check and schema.`);
}
