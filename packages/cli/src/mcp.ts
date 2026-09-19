import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LAYERS, EDGE_TYPES, type Layer, type EdgeType, log } from '@memory-layer/core';
import * as api from './api.js';
import { isStale, storeDirOrThrow } from './project.js';

/**
 * MCP server over stdio.
 *
 * Nothing here may write to stdout except the protocol itself; diagnostics go to
 * the log file and stderr. A stray console.log corrupts the framing and the
 * failure looks like the server being broken rather than noisy.
 */

const TOOLS = [
  {
    name: 'dai_memory_search',
    description:
      'Search project memory for decisions, errors, constraints and past sessions. ' +
      'Returns ranked results plus a fusion report saying which retrieval branches contributed.',
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
      'Why is this code the way it is? Returns the decisions and constraints touching a ' +
      'file path or symbol, with the errors they were made in response to. ' +
      'Use before changing code you did not write.',
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
    description: 'Fetch one memory node in full, with its direct edges.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'dai_memory_neighbors',
    description:
      'Walk the memory graph out from a node. Traversal is bidirectional, so asking from ' +
      'an error reaches the decision that resolved it.',
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
      'Record a decision, error, constraint or procedure. Always include the reason it was ' +
      'chosen over the alternative -- a decision without its reason cannot be re-evaluated later. ' +
      'A source_ref with a line span is anchored to the declarations it covers automatically, and ' +
      'the reply names any existing memories close enough to be worth linking.',
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
    description: 'Link two memory nodes with a typed relationship.',
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
    description:
      'The decisions and constraints currently in force for this project, most important ' +
      'first. Use at the start of a task to learn what the project has already settled.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'dai_memory_map',
    description:
      'The code graph: which files declare what, what each declaration calls and is ' +
      'called by, what it inherits, which files import which, and which memory is about ' +
      'each declaration. Use to get oriented in an unfamiliar area before reading files ' +
      'one by one, and to see what reaches a declaration before changing it. Pass a path ' +
      'prefix to narrow it -- edges leaving the prefix are counted so a narrowed view is ' +
      'not mistaken for an isolated one.',
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
      'What breaks if a declaration changes. Upstream lists its dependents (callers, derived ' +
      'types, callers of its members) by distance: d=1 WILL BREAK, d=2 LIKELY AFFECTED, d=3 MAY ' +
      'NEED TESTING, each with the confidence of the edge that reached it, plus the files that ' +
      'import it and a risk level with its reasons. Downstream lists what it depends on. Run it ' +
      'before editing a function, class or method. A name that fits several declarations comes ' +
      'back as ranked candidates to choose from with `uid`.',
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
      'Everything around one declaration: what encloses it, its members, who calls it, what it ' +
      'calls, the types it derives from and those derived from it, its file\'s imports and ' +
      'importers, and the memory recorded about it.',
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
      'How one declaration reaches another: the shortest path over calls, entering types through ' +
      'their members. With no path, says where the chain breaks and whether the depth limit cut ' +
      'the search short.',
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
      'Ask the code graph in words and get back the execution flows the answer runs in, rather ' +
      'than a list of files. Declarations that match but belong to no flow come back in their own ' +
      'group, so unreachable code is visible rather than dropped.',
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
      'Every execution flow in this repository: an entry point -- a declaration nothing here calls, ' +
      'which calls others -- and what it reaches. Use it to learn what a codebase does before ' +
      'changing it. The rule that found the entry points is reported with the answer.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, includeTests: { type: 'boolean' } },
    },
  },
  {
    name: 'dai_memory_process',
    description:
      'One execution flow, step by step, with each step\'s distance from the entry point and the ' +
      'confidence of the call that reached it. A name that fits several flows is answered with all ' +
      'of them rather than a guess.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, includeTests: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'dai_memory_detect_changes',
    description:
      'What the current diff changes, in declarations rather than lines: which indexed declarations '
      + 'the hunks touched, what depends on each, which execution flows run through them, and the risk. '
      + 'Run it before committing. Hunks that match no indexed declaration are counted and reported, '
      + 'and a stale graph is declared rather than silently trusted.',
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
      'This branch as a reviewer wants it: what can break code outside the file it was changed in, '
      + 'which modules it lands in, and who has committed to those files before. The last of those is '
      + 'history, not a recommendation, and the answer says so.',
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
      'Rename a declaration through the call graph: the declaration, the calls resolved to it, and '
      + 'the types deriving from it, each with the confidence of the edge that found it. Other '
      + 'occurrences of the word -- comments, strings, a different declaration with the same name -- '
      + 'are reported separately and never rewritten unless asked. Shows a plan; apply must be asked '
      + 'for. Refuses when the graph is older than the working tree, and when the name is ambiguous.',
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
    name: 'dai_memory_clusters',
    description:
      'Groups of related memories, with the summary somebody wrote for each group ' +
      'if one exists. Use for a broad question about an area rather than one symbol. ' +
      'Detection only -- nothing here generates a summary.',
    inputSchema: { type: 'object', properties: { min_size: { type: 'number' } } },
  },
  {
    name: 'dai_memory_summarize',
    description:
      'Record a summary you wrote for a group from dai_memory_clusters. The body is ' +
      'yours: this tool stores it and links it to the group members, so it survives ' +
      'the grouping being recomputed. Read the members before writing one.',
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
      'What memory already records about the files this change touches. Run before ' +
      'committing: it is the moment a change can contradict a decision someone made ' +
      'and wrote down. Reports files with nothing recorded too, so silence is visible.',
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
      'Contradictions between recorded decisions that a person needs to settle. ' +
      'Check this before recording a new decision.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function serve(): Promise<void> {
  const server = new Server(
    { name: 'memory-layer', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
