import { ruleForFile, newParser } from '../ingest/languages.js';

/**
 * What one declaration does to its own values: which line gives a name its
 * value, which lines read it, and which lines only run under a condition.
 *
 * This is the inside of a function, where the call graph has nothing to say.
 * It is built from the syntax tree rather than from patterns, so it knows an
 * assignment from a comparison, but it stops well short of a full program
 * dependence graph: no aliasing, no fields, no values crossing a call. Those
 * limits are reported with the answer rather than left to be discovered.
 */

interface AstNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children?: AstNode[];
  childForFieldName?(field: string): AstNode | null;
}

/** Node types that give a name a value, across the grammars this indexes. */
const ASSIGNMENT = /assignment|variable_declarator|augmented_assignment|short_var_declaration|let_declaration|init_declarator|parameter|formal_parameter|typed_parameter|identifier_pattern/i;
/** Node types that run their body only sometimes. */
const CONTROL = /if_statement|else_clause|for_statement|for_in_statement|while_statement|do_statement|switch_statement|case|try_statement|catch_clause|except_clause|conditional_expression|match_statement|guard/i;
const IDENTIFIER = /^identifier$|^type_identifier$|^property_identifier$|^field_identifier$|^shorthand_property_identifier/;

export interface Definition {
  name: string;
  line: number;
  /** The statement the name got its value from, trimmed. */
  text: string;
  kind: string;
}

export interface Use {
  name: string;
  line: number;
  text: string;
}

export interface ControlRegion {
  kind: string;
  line: number;
  endLine: number;
  /** The condition as written, when the grammar names one. */
  condition: string | null;
}

export interface PdgResult {
  status: 'ok';
  file: string;
  startLine: number;
  endLine: number;
  language: string;
  definitions: Definition[];
  uses: Use[];
  control: ControlRegion[];
  /** Each name, to the lines that give it a value and the lines that read it. */
  names: Array<{ name: string; definedAt: number[]; usedAt: number[]; underControl: boolean }>;
  limits: string[];
}

export type PdgFailure = { status: 'unsupported'; file: string; reason: string };

function lineOf(node: AstNode, offset: number): number {
  return node.startPosition.row + 1 + offset;
}

/**
 * The definitions, uses and conditional regions inside one declaration.
 *
 * `offset` is the declaration's first line in the file, so every line number
 * here is a line number in the file rather than in the snippet.
 */
export async function pdg(
  file: string,
  content: string,
  range: { startLine: number; endLine: number },
): Promise<PdgResult | PdgFailure> {
  const rule = ruleForFile(file);
  if (rule.mode !== 'AST_DECLARATION') {
    return { status: 'unsupported', file, reason: `${rule.label ?? 'this language'} is not parsed into a syntax tree by this build, so the inside of a declaration cannot be read.` };
  }
  const parser = await newParser(rule);
  if (!parser) {
    return { status: 'unsupported', file, reason: `the grammar for ${rule.label ?? 'this language'} could not be loaded.` };
  }

  const lines = content.split(/\r?\n/);
  const snippet = lines.slice(range.startLine - 1, range.endLine).join('\n');
  const offset = range.startLine - 1;

  let tree: { rootNode: AstNode } | null = null;
  try {
    tree = parser.parse(snippet) as { rootNode: AstNode };
    const definitions: Definition[] = [];
    const uses: Use[] = [];
    const control: ControlRegion[] = [];

    const stack: AstNode[] = [...(tree.rootNode.children ?? [])];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const line = lineOf(node, offset);
      const text = node.text.split('\n')[0]!.trim().slice(0, 160);

      if (CONTROL.test(node.type)) {
        const condition = node.childForFieldName?.('condition') ?? null;
        control.push({
          kind: node.type,
          line,
          endLine: node.endPosition.row + 1 + offset,
          condition: condition ? condition.text.trim().slice(0, 120) : null,
        });
      }

      if (ASSIGNMENT.test(node.type)) {
        const left = node.childForFieldName?.('left')
          ?? node.childForFieldName?.('name')
          ?? node.childForFieldName?.('pattern')
          ?? (node.children ?? []).find((child) => IDENTIFIER.test(child.type))
          ?? null;
        if (left && IDENTIFIER.test(left.type)) {
          definitions.push({ name: left.text, line, text, kind: node.type });
        }
      } else if (IDENTIFIER.test(node.type)) {
        uses.push({ name: node.text, line, text });
      }

      for (const child of node.children ?? []) stack.push(child);
    }

    const byName = new Map<string, { definedAt: Set<number>; usedAt: Set<number> }>();
    const entry = (name: string) => {
      const found = byName.get(name) ?? { definedAt: new Set<number>(), usedAt: new Set<number>() };
      byName.set(name, found);
      return found;
    };
    for (const definition of definitions) entry(definition.name).definedAt.add(definition.line);
    for (const use of uses) entry(use.name).usedAt.add(use.line);

    const underControl = (line: number): boolean =>
      control.some((region) => line > region.line && line <= region.endLine);

    return {
      status: 'ok',
      file,
      startLine: range.startLine,
      endLine: range.endLine,
      language: rule.label ?? 'unknown',
      definitions: definitions.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
      uses: uses.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
      control: control.sort((a, b) => a.line - b.line),
      names: [...byName].map(([name, places]) => ({
        name,
        definedAt: [...places.definedAt].sort((a, b) => a - b),
        usedAt: [...places.usedAt].sort((a, b) => a - b),
        underControl: [...places.usedAt].some(underControl),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      limits: [
        'One declaration at a time, from its syntax tree: names, where each is given a value, where each is read, and which lines run only under a condition.',
        'Not tracked: aliases, fields of an object, values that travel through a call, and which definition reaches which use when a name is assigned more than once.',
        'A name defined and used on the same line -- `x = x + 1` -- appears in both lists, because that is what the tree says.',
      ],
    };
  } finally {
    // The wasm tree and parser hold memory outside the JS heap; the ingest
    // path frees them the same way, and a leak here shows up as a Zone abort
    // several files later rather than as an error at the leak.
    const free = (value: unknown): void => {
      const disposable = value as { delete?: () => void } | null;
      if (disposable && typeof disposable.delete === 'function') disposable.delete();
    };
    free(tree);
    free(parser);
  }
}
