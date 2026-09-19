import type { CodeIndex, SymbolRef } from './code.js';
import { symbolRef, isTestPath } from './code.js';

/**
 * Renaming a declaration through the graph rather than through the text.
 *
 * Find-and-replace renames a word. It hits the comment that mentions it, the
 * string that happens to contain it, and the unrelated function three
 * directories away with the same name -- and misses nothing, which is how it
 * passes review. This walks the call and inheritance edges instead: every site
 * it rewrites is one the graph says refers to this declaration, and it carries
 * the confidence of the edge that found it.
 *
 * The edits a text search would make and the graph does not account for are
 * still reported -- separately, and not applied unless they are asked for. A
 * rename that silently leaves a string literal behind is the bug the next
 * person spends an afternoon on, and one that silently changes it is worse.
 *
 * Nothing here touches the filesystem: files come in as text and edits go out
 * as positions, so a plan can be made, shown and thrown away.
 */

export interface RenameEdit {
  file: string;
  /** One-based, as an editor counts. */
  line: number;
  column: number;
  /** What the rename replaces, so an apply can verify before writing. */
  before: string;
  /** Why this site is believed to refer to the target. */
  via: 'declaration' | 'call' | 'inherits' | 'member';
  confidence: number;
}

export interface TextMatch {
  file: string;
  line: number;
  column: number;
  /** The line it sits on, trimmed, so a person can judge it. */
  context: string;
  /** Why the graph does not account for it. */
  reason: 'comment or string' | 'not in the code graph' | 'another declaration with this name';
}

export interface RenamePlan {
  status: 'ok';
  target: SymbolRef;
  from: string;
  to: string;
  edits: RenameEdit[];
  /** Sites a text search would change and the graph cannot vouch for. */
  textOnly: TextMatch[];
  summary: {
    files: number;
    edits: number;
    /** Edits below the confidence a type-resolved call would have. */
    uncertain: number;
    /** Call sites the graph knows about where the name was not found on the line. */
    missed: number;
    textOnly: number;
  };
  limits: string[];
}

export type RenameRefusal =
  | { status: 'invalid_name'; to: string; reason: string }
  | { status: 'occupied'; to: string; conflicts: SymbolRef[] };

/** A name a rename may write: an identifier, in the languages this indexes. */
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

function occurrences(line: string, name: string): number[] {
  const found: number[] = [];
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_$]/u.test(ch);
  let at = line.indexOf(name);
  while (at !== -1) {
    if (!isWordChar(line[at - 1]) && !isWordChar(line[at + name.length])) found.push(at);
    at = line.indexOf(name, at + 1);
  }
  return found;
}

/** Where a line ends up in a file's text, one-based. */
function lineAt(lines: string[], line: number): string | undefined {
  return lines[line - 1];
}

export interface RenameOptions {
  /** Called for each file the plan needs; undefined means the file is unreadable. */
  read: (file: string) => string | undefined;
  includeTests?: boolean;
  /** Also look for the bare word everywhere else, to report what is left behind. */
  scanText?: Iterable<string>;
}

/**
 * Every site that has to change for a declaration to have a different name.
 *
 * The declaration itself, the calls the graph resolved to it, the types that
 * derive from it, and -- for a type -- nothing else: its members keep their own
 * names. Each site is checked against the file's text before it is offered, so
 * a stale line number is reported as a miss rather than rewritten blind.
 */
export function planRename(
  index: CodeIndex,
  targetId: string,
  to: string,
  options: RenameOptions,
): RenamePlan | RenameRefusal {
  const target = symbolRef(index, targetId);
  const from = target.name;

  if (!IDENTIFIER.test(to)) {
    return { status: 'invalid_name', to, reason: 'a name must be an identifier: letters, digits, _ or $, not starting with a digit' };
  }
  if (to === from) {
    return { status: 'invalid_name', to, reason: 'the new name is the old one' };
  }

  // A name already used in the same file is a collision this cannot resolve.
  const conflicts = (index.byName.get(to.toLowerCase()) ?? [])
    .map((id) => symbolRef(index, id))
    .filter((ref) => ref.name === to && ref.filePath === target.filePath);
  if (conflicts.length > 0) {
    return { status: 'occupied', to, conflicts };
  }

  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (!cache.has(file)) {
      const text = options.read(file);
      cache.set(file, text === undefined ? null : text.split(/\r?\n/));
    }
    return cache.get(file)!;
  };

  const edits: RenameEdit[] = [];
  let missed = 0;

  const addSite = (file: string, line: number, via: RenameEdit['via'], confidence: number): void => {
    const lines = linesOf(file);
    const text = lines ? lineAt(lines, line) : undefined;
    if (text === undefined) {
      missed += 1;
      return;
    }
    const columns = occurrences(text, from);
    if (columns.length === 0) {
      // The graph says the name is here and the text disagrees: the file moved
      // on since it was indexed. Counted, never guessed at.
      missed += 1;
      return;
    }
    for (const column of columns) {
      edits.push({ file, line, column: column + 1, before: from, via, confidence });
    }
  };

  addSite(target.filePath, target.startLine, 'declaration', 1);

  for (const edge of index.callsIn.get(targetId) ?? []) {
    const caller = index.symbols.get(edge.to);
    if (!caller) continue;
    if (!options.includeTests && isTestPath(caller.filePath)) continue;
    addSite(caller.filePath, edge.line > 0 ? edge.line : caller.startLine, 'call', edge.confidence);
  }

  for (const edge of index.inheritsIn.get(targetId) ?? []) {
    const derived = index.symbols.get(edge.to);
    if (!derived) continue;
    if (!options.includeTests && isTestPath(derived.filePath)) continue;
    addSite(derived.filePath, derived.startLine, 'inherits', edge.confidence);
  }

  // One site can be reached twice -- a caller that calls it on two lines, or a
  // declaration that is also a call target. Keep one edit per position.
  const unique = new Map<string, RenameEdit>();
  for (const edit of edits) {
    const key = `${edit.file}:${edit.line}:${edit.column}`;
    const seen = unique.get(key);
    if (!seen || edit.confidence > seen.confidence) unique.set(key, edit);
  }
  const planned = [...unique.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  // What a text search would also change. Reported, never applied by default:
  // the graph cannot say these refer to the target, and some of them do not.
  const textOnly: TextMatch[] = [];
  const editedPositions = new Set(planned.map((edit) => `${edit.file}:${edit.line}:${edit.column}`));
  const sameName = new Set(
    (index.byName.get(from.toLowerCase()) ?? [])
      .map((id) => symbolRef(index, id))
      .filter((ref) => ref.name === from && ref.id !== targetId)
      .map((ref) => ref.filePath),
  );
  for (const file of options.scanText ?? []) {
    const lines = linesOf(file);
    if (!lines) continue;
    lines.forEach((text, i) => {
      for (const column of occurrences(text, from)) {
        const key = `${file}:${i + 1}:${column + 1}`;
        if (editedPositions.has(key)) continue;
        textOnly.push({
          file,
          line: i + 1,
          column: column + 1,
          context: text.trim().slice(0, 160),
          reason: sameName.has(file)
            ? 'another declaration with this name'
            : index.importsOut.has(file) || index.importsIn.has(file)
              ? 'comment or string'
              : 'not in the code graph',
        });
      }
    });
  }

  const files = new Set(planned.map((edit) => edit.file));
  const limits: string[] = [
    'Only sites the code graph resolved to this declaration are rewritten. Dynamic calls, reflection and names built from strings are not in the graph and will not be changed.',
  ];
  if (missed > 0) {
    limits.push(`${missed} site(s) the graph knows about do not have this name on the line recorded for them: the files have changed since the index was built. Re-run ingest.`);
  }
  if (textOnly.length > 0) {
    limits.push(`${textOnly.length} other occurrence(s) of the word were found and are not part of this rename.`);
  }

  return {
    status: 'ok',
    target,
    from,
    to,
    edits: planned,
    textOnly,
    summary: {
      files: files.size,
      edits: planned.length,
      uncertain: planned.filter((edit) => edit.confidence < 0.95).length,
      missed,
      textOnly: textOnly.length,
    },
    limits,
  };
}

export interface AppliedRename {
  file: string;
  edits: number;
  text: string;
}

/**
 * The plan, as new file contents.
 *
 * Edits are applied from the end of each file backwards so earlier positions
 * stay valid, and every one is checked against the text it claims to replace:
 * a file that changed between planning and applying rewrites nothing.
 */
export function applyRename(
  plan: RenamePlan,
  read: (file: string) => string | undefined,
  which: RenameEdit[] = plan.edits,
): { files: AppliedRename[]; skipped: Array<{ file: string; line: number; column: number; reason: string }> } {
  const byFile = new Map<string, RenameEdit[]>();
  for (const edit of which) {
    const list = byFile.get(edit.file);
    if (list) list.push(edit);
    else byFile.set(edit.file, [edit]);
  }

  const files: AppliedRename[] = [];
  const skipped: Array<{ file: string; line: number; column: number; reason: string }> = [];

  for (const [file, fileEdits] of byFile) {
    const text = read(file);
    if (text === undefined) {
      for (const edit of fileEdits) skipped.push({ file, line: edit.line, column: edit.column, reason: 'the file could not be read' });
      continue;
    }
    const lines = text.split(/\r?\n/);
    const ordered = [...fileEdits].sort((a, b) => b.line - a.line || b.column - a.column);
    let applied = 0;
    for (const edit of ordered) {
      const line = lines[edit.line - 1];
      if (line === undefined) {
        skipped.push({ file, line: edit.line, column: edit.column, reason: 'the line is no longer in the file' });
        continue;
      }
      const at = edit.column - 1;
      if (line.slice(at, at + edit.before.length) !== edit.before) {
        skipped.push({ file, line: edit.line, column: edit.column, reason: `expected ${JSON.stringify(edit.before)} at this position and the file has something else` });
        continue;
      }
      lines[edit.line - 1] = line.slice(0, at) + plan.to + line.slice(at + edit.before.length);
      applied += 1;
    }
    if (applied > 0) {
      files.push({ file, edits: applied, text: lines.join(text.includes('\r\n') ? '\r\n' : '\n') });
    }
  }

  return { files, skipped };
}
