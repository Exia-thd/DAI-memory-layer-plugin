import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import v8 from 'node:v8';
import { log } from '../util/log.js';

const require = createRequire(import.meta.url);

/**
 * Which grammar handles which extension, and how a file of that kind is cut.
 *
 * A table keyed by label, rather than a chain of extension tests, so adding a
 * language is a row rather than a branch.
 */
export type ChunkMode = 'AST_DECLARATION' | 'MARKDOWN_HEADING' | 'CHARACTER';

export interface LanguageRule {
  label: string;
  grammar: string | null;
  mode: ChunkMode;
  /** Node types that mark a chunk boundary, among the top-level nodes. */
  boundaries: string[];
  /**
   * Node types recorded as declarations, found at any depth.
   *
   * Separate from `boundaries` because the two questions differ: where to cut a
   * file into chunks is a top-level decision, but what a file declares includes
   * every method inside every class. Using one list for both is how methods
   * were never recorded in any language -- they live inside class bodies, and
   * the walk only ever looked at the top.
   */
  symbols?: string[];
  /**
   * Symbol types that count only directly under the file or an export wrapper.
   *
   * `const x = ...` names something at module scope and nothing worth keeping
   * inside a function body. Walking into every function would record every
   * local variable in the repository.
   */
  topLevelOnly?: string[];
  /**
   * Symbol types that bind a value rather than open a scope: recorded at file,
   * module or type level, skipped inside a function body or another value.
   *
   * Looser than `topLevelOnly`, for languages where members are bindings too:
   * a Kotlin property, an OCaml `let` inside a module, a Zig `const` that
   * holds a struct. `val local = 1` inside a function is the same node type as
   * the property, and recording it would put every local in the graph.
   */
  variables?: string[];
  /**
   * Node types the chunker looks through rather than treating as one unit.
   *
   * A C# file is usually one namespace wrapping everything; without looking
   * through it the whole file is a single top-level node, and a single chunk.
   */
  containers?: string[];
  /** Pack adjacent small boundaries into one chunk, for data formats. */
  pack?: boolean;
  /** The grammar file ships in this package's `grammars/`, not in tree-sitter-wasms. */
  vendored?: boolean;
  /**
   * How this grammar spells what one piece of code does to another.
   *
   * Measured like the rest of this table. A language with no entry here still
   * gets declarations and chunks; it contributes no calls, imports or base
   * types, and `doctor` counts it as such rather than implying the repository
   * has none.
   */
  relations?: {
    /** Node types that are a call or a construction. */
    calls?: string[];
    /**
     * Of those, the ones that construct a type: `new Order()`.
     *
     * A construction means a class, a record, a struct -- never a method. Told
     * apart because a repository full of entities has a property named after
     * its type, and `new Customer()` matching the property `Customer` is how a
     * hundred calls land on the wrong declaration or on none.
     */
    constructs?: string[];
    /**
     * Fields that hold the thing being called, tried in order. Objective-C
     * needs two: a C call keeps it in `function`, a message in `selector`.
     */
    calleeFields?: string[];
    /** Node types that import another module. */
    imports?: string[];
    /** Field holding the module text; `source` unless the grammar differs. */
    importSource?: string;
    /** Node types listing base classes and interfaces. */
    heritage?: string[];
    /** Fields holding base types where the grammar gives them no node of their own. */
    heritageFields?: string[];
    /** Callee names that are an import: Ruby's `require`, Elixir's `alias`. */
    importCalls?: string[];
    /** Callee names that are syntax rather than a call: Elixir's `defmodule`. */
    ignoreCallees?: string[];
    /** Node types that name the file's namespace, package or module. */
    container?: string[];
  };
}

/**
 * Every node type below was measured by parsing a sample with the grammar that
 * ships in `tree-sitter-wasms`, not written from memory. A remembered node name
 * that does not exist in the grammar produces a language that looks supported,
 * parses without error, and records nothing -- which is how Java's
 * `method_declaration` sat in this table for months without ever firing.
 */
const RULES: Record<string, LanguageRule> = {
  typescript: {
    label: 'typescript',
    grammar: 'tree-sitter-typescript.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_declaration', 'class_declaration', 'abstract_class_declaration', 'method_definition',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'lexical_declaration', 'export_statement', 'internal_module',
    ],
    symbols: [
      'class_declaration', 'abstract_class_declaration', 'interface_declaration',
      'type_alias_declaration', 'enum_declaration', 'function_declaration',
      'method_definition', 'abstract_method_signature', 'internal_module', 'lexical_declaration',
    ],
    topLevelOnly: ['lexical_declaration'],
    relations: {
      calls: ['call_expression', 'new_expression'],
      constructs: ['new_expression'],
      imports: ['import_statement'],
      heritage: ['class_heritage'],
    },
  },
  tsx: {
    label: 'tsx',
    grammar: 'tree-sitter-tsx.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_declaration', 'class_declaration', 'abstract_class_declaration', 'method_definition',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'lexical_declaration', 'export_statement', 'internal_module',
    ],
    symbols: [
      'class_declaration', 'abstract_class_declaration', 'interface_declaration',
      'type_alias_declaration', 'enum_declaration', 'function_declaration',
      'method_definition', 'abstract_method_signature', 'internal_module', 'lexical_declaration',
    ],
    topLevelOnly: ['lexical_declaration'],
    relations: {
      calls: ['call_expression', 'new_expression'],
      constructs: ['new_expression'],
      imports: ['import_statement'],
      heritage: ['class_heritage'],
    },
  },
  javascript: {
    label: 'javascript',
    grammar: 'tree-sitter-javascript.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_declaration', 'class_declaration', 'method_definition',
      'lexical_declaration', 'export_statement',
    ],
    symbols: ['class_declaration', 'function_declaration', 'method_definition', 'lexical_declaration'],
    topLevelOnly: ['lexical_declaration'],
    relations: {
      calls: ['call_expression', 'new_expression'],
      constructs: ['new_expression'],
      imports: ['import_statement'],
      heritage: ['class_heritage'],
    },
  },
  python: {
    label: 'python',
    grammar: 'tree-sitter-python.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition', 'class_definition', 'decorated_definition'],
    symbols: ['class_definition', 'function_definition'],
    relations: {
      calls: ['call'],
      imports: ['import_statement', 'import_from_statement'],
      // `class Invoice(Base, Store)` -- the bases are an argument list, reachable
      // only as a field, since an argument list elsewhere is just arguments.
      heritageFields: ['superclasses'],
    },
  },
  go: {
    label: 'go',
    grammar: 'tree-sitter-go.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_declaration', 'method_declaration', 'type_declaration'],
    symbols: ['function_declaration', 'method_declaration', 'type_spec', 'method_spec'],
    relations: {
      calls: ['call_expression'],
      imports: ['import_spec'],
      importSource: 'path',
      container: ['package_clause'],
    },
  },
  rust: {
    label: 'rust',
    grammar: 'tree-sitter-rust.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'function_item', 'struct_item', 'impl_item', 'trait_item', 'enum_item',
      'mod_item', 'macro_definition', 'type_item', 'const_item',
    ],
    symbols: [
      'function_item', 'function_signature_item', 'struct_item', 'enum_item', 'trait_item',
      'mod_item', 'type_item', 'const_item', 'macro_definition',
    ],
    relations: {
      calls: ['call_expression', 'macro_invocation'],
      imports: ['use_declaration'],
    },
  },
  java: {
    label: 'java',
    grammar: 'tree-sitter-java.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'class_declaration', 'interface_declaration', 'record_declaration',
      'enum_declaration', 'annotation_type_declaration',
    ],
    symbols: [
      'class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration',
      'annotation_type_declaration', 'method_declaration', 'constructor_declaration',
    ],
    relations: {
      // Java puts the called name in `name` and the receiver in `object`.
      calls: ['method_invocation', 'object_creation_expression'],
      constructs: ['object_creation_expression'],
      calleeFields: ['name'],
      imports: ['import_declaration'],
      heritage: ['superclass', 'super_interfaces'],
      container: ['package_declaration'],
    },
  },
  c_sharp: {
    label: 'c_sharp',
    grammar: 'tree-sitter-c_sharp.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'class_declaration', 'interface_declaration', 'record_declaration',
      'struct_declaration', 'enum_declaration', 'delegate_declaration',
    ],
    symbols: [
      'class_declaration', 'interface_declaration', 'record_declaration', 'struct_declaration',
      'enum_declaration', 'delegate_declaration', 'method_declaration',
      'constructor_declaration', 'property_declaration',
    ],
    // Everything in a C# file sits inside a namespace -- block-scoped or, since
    // C# 10, file-scoped. Not looked through, the namespace is the file's only
    // top-level node, and the whole file is one unit.
    containers: ['namespace_declaration', 'file_scoped_namespace_declaration', 'declaration_list'],
    relations: {
      calls: ['invocation_expression', 'object_creation_expression'],
      constructs: ['object_creation_expression'],
      imports: ['using_directive'],
      heritage: ['base_list'],
      container: ['namespace_declaration', 'file_scoped_namespace_declaration'],
    },
  },
  kotlin: {
    label: 'kotlin',
    grammar: 'tree-sitter-kotlin.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class_declaration', 'object_declaration', 'function_declaration'],
    symbols: ['class_declaration', 'object_declaration', 'function_declaration', 'property_declaration'],
    variables: ['property_declaration'],
    relations: {
      calls: ['call_expression'],
      imports: ['import_header'],
      heritage: ['delegation_specifier'],
      container: ['package_header'],
    },
  },
  scala: {
    label: 'scala',
    grammar: 'tree-sitter-scala.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class_definition', 'trait_definition', 'object_definition', 'function_definition'],
    symbols: [
      'class_definition', 'trait_definition', 'object_definition',
      'function_definition', 'function_declaration',
    ],
    relations: {
      calls: ['call_expression'],
      imports: ['import_declaration'],
      importSource: 'path',
      heritage: ['extends_clause'],
      container: ['package_clause'],
    },
  },
  swift: {
    label: 'swift',
    grammar: 'tree-sitter-swift.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class_declaration', 'protocol_declaration', 'function_declaration'],
    symbols: [
      'class_declaration', 'protocol_declaration', 'function_declaration',
      'protocol_function_declaration', 'init_declaration', 'property_declaration',
      'typealias_declaration',
    ],
    variables: ['property_declaration'],
    relations: {
      calls: ['call_expression'],
      imports: ['import_declaration'],
      heritage: ['inheritance_specifier'],
    },
  },
  dart: {
    label: 'dart',
    grammar: 'tree-sitter-dart.wasm',
    mode: 'AST_DECLARATION',
    // A top-level Dart function is a signature followed by a sibling body, so
    // it is left as filler and the two stay in one chunk; its name is still
    // recorded through `symbols`.
    boundaries: ['class_definition', 'mixin_declaration', 'enum_declaration', 'extension_declaration'],
    symbols: [
      'class_definition', 'mixin_declaration', 'enum_declaration', 'extension_declaration',
      'function_signature', 'constructor_signature',
    ],
    relations: {
      // Dart has no call node. `repo.findById(id)` is an identifier followed by
      // two selectors, so the argument list is what marks a call and the name
      // is read backwards from it -- see `dartCall`.
      calls: ['argument_part'],
      imports: ['import_or_export'],
      heritage: ['superclass', 'interfaces'],
    },
  },
  php: {
    label: 'php',
    grammar: 'tree-sitter-php.wasm',
    mode: 'AST_DECLARATION',
    boundaries: [
      'class_declaration', 'interface_declaration', 'trait_declaration',
      'enum_declaration', 'function_definition',
    ],
    symbols: [
      'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration',
      'function_definition', 'method_declaration',
    ],
    relations: {
      calls: [
        'member_call_expression', 'function_call_expression',
        'scoped_call_expression', 'object_creation_expression',
      ],
      constructs: ['object_creation_expression'],
      calleeFields: ['name', 'function'],
      imports: ['namespace_use_declaration'],
      heritage: ['base_clause', 'class_interface_clause'],
      container: ['namespace_definition'],
    },
    containers: ['namespace_definition', 'compound_statement'],
  },
  ruby: {
    label: 'ruby',
    grammar: 'tree-sitter-ruby.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class', 'method', 'singleton_method'],
    symbols: ['module', 'class', 'method', 'singleton_method'],
    relations: {
      calls: ['call'],
      calleeFields: ['method'],
      importCalls: ['require', 'require_relative', 'load'],
      heritage: ['superclass'],
    },
    containers: ['module', 'body_statement'],
  },
  c: {
    label: 'c',
    grammar: 'tree-sitter-c.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition', 'struct_specifier', 'enum_specifier', 'union_specifier', 'type_definition'],
    symbols: ['function_definition', 'struct_specifier', 'enum_specifier', 'union_specifier', 'type_definition'],
    relations: {
      calls: ['call_expression'],
      imports: ['preproc_include'],
      importSource: 'path',
    },
  },
  cpp: {
    label: 'cpp',
    grammar: 'tree-sitter-cpp.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'union_specifier'],
    symbols: ['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'union_specifier'],
    relations: {
      calls: ['call_expression'],
      imports: ['preproc_include'],
      importSource: 'path',
      heritage: ['base_class_clause'],
      container: ['namespace_definition'],
    },
    containers: ['namespace_definition', 'declaration_list', 'template_declaration', 'linkage_specification'],
  },
  objc: {
    label: 'objc',
    grammar: 'tree-sitter-objc.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['class_interface', 'class_implementation', 'protocol_declaration', 'function_definition'],
    symbols: [
      'class_interface', 'class_implementation', 'protocol_declaration',
      'method_declaration', 'method_definition', 'function_definition',
    ],
    relations: {
      calls: ['call_expression', 'message_expression'],
      // A C call keeps the callee in `function`; an Objective-C message keeps
      // the selector in `method`, with the object in `receiver`.
      calleeFields: ['function', 'method'],
      imports: ['preproc_include'],
      importSource: 'path',
    },
  },
  // Vendored too. The Lua grammar in tree-sitter-wasms parses correctly only
  // the first time in a runtime: the second parse of the same source, with a
  // fresh parser, comes back with ERROR nodes -- so in an ingest only the
  // first Lua file was read. The maintained grammar has no such state.
  lua: {
    label: 'lua',
    grammar: 'tree-sitter-lua.wasm',
    vendored: true,
    mode: 'AST_DECLARATION',
    boundaries: ['function_declaration'],
    symbols: ['function_declaration'],
    relations: {
      calls: ['function_call'],
      calleeFields: ['name'],
      importCalls: ['require'],
    },
  },
  // Vendored as well. The bash grammar in tree-sitter-wasms fails on any
  // `case ... in`: its scanner calls a function the runtime does not export
  // ("resolved is not a function"), and the runtime then aborts. Nearly every
  // real shell script has a `case`, so a scan of one lost almost all of them --
  // it looked like the runtime running out of memory, and was not.
  bash: {
    label: 'bash',
    grammar: 'tree-sitter-bash.wasm',
    vendored: true,
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition'],
    symbols: ['function_definition'],
    relations: {
      calls: ['command'],
      calleeFields: ['name'],
      importCalls: ['source', '.'],
    },
  },
  elixir: {
    label: 'elixir',
    grammar: 'tree-sitter-elixir.wasm',
    mode: 'AST_DECLARATION',
    // Elixir has no declaration syntax: `defmodule` and `def` are ordinary
    // calls, so a `call` is a symbol only when its target is one of them. The
    // chunker's name resolver knows the shape.
    boundaries: ['call'],
    symbols: ['call'],
    containers: ['do_block'],
    relations: {
      calls: ['call'],
      calleeFields: ['target'],
      importCalls: ['alias', 'import', 'require', 'use'],
      ignoreCallees: [
        'defmodule', 'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp',
        'defdelegate', 'defprotocol', 'defimpl', 'defexception', 'defstruct',
      ],
    },
  },
  ocaml: {
    label: 'ocaml',
    grammar: 'tree-sitter-ocaml.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['module_definition', 'type_definition', 'value_definition', 'module_type_definition'],
    symbols: ['module_binding', 'type_binding', 'module_type_definition', 'let_binding'],
    variables: ['let_binding'],
    relations: {
      calls: ['application_expression'],
      imports: ['open_module'],
    },
  },
  zig: {
    label: 'zig',
    grammar: 'tree-sitter-zig.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_declaration', 'variable_declaration'],
    symbols: ['function_declaration', 'variable_declaration'],
    variables: ['variable_declaration'],
    relations: { calls: ['call_expression'] },
  },
  solidity: {
    label: 'solidity',
    grammar: 'tree-sitter-solidity.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['contract_declaration', 'interface_declaration', 'library_declaration'],
    symbols: [
      'contract_declaration', 'interface_declaration', 'library_declaration',
      'function_definition', 'event_definition', 'modifier_definition', 'struct_declaration',
    ],
    relations: {
      calls: ['call_expression'],
      imports: ['import_directive'],
      importSource: 'source',
      heritage: ['inheritance_specifier'],
    },
  },
  rescript: {
    label: 'rescript',
    grammar: 'tree-sitter-rescript.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['type_declaration', 'module_declaration', 'let_declaration'],
    symbols: ['type_binding', 'module_binding', 'let_binding'],
    variables: ['let_binding'],
    relations: {
      calls: ['call_expression'],
      imports: ['open_statement'],
    },
  },
  elisp: {
    label: 'elisp',
    grammar: 'tree-sitter-elisp.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['function_definition', 'macro_definition'],
    symbols: ['function_definition', 'macro_definition'],
    relations: {
      // Everything in Lisp is a list whose head is the thing being called.
      calls: ['list'],
      importCalls: ['require', 'load'],
      // Special forms are syntax, not calls into this code.
      ignoreCallees: [
        'defun', 'defmacro', 'defvar', 'defconst', 'defcustom', 'let', 'let*',
        'if', 'when', 'unless', 'cond', 'while', 'progn', 'prog1', 'setq', 'setf',
        'lambda', 'quote', 'function', 'and', 'or', 'not', 'condition-case',
        'save-excursion', 'with-current-buffer', 'dolist', 'dotimes',
      ],
    },
  },
  systemrdl: {
    label: 'systemrdl',
    grammar: 'tree-sitter-systemrdl.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['component_def'],
    symbols: ['component_named_def'],
    containers: ['description'],
    relations: {
      // A register description has no calls; instantiating a component is the
      // relation it does have -- `ctrl_r ctrl @ 0x0;` uses the `ctrl_r` type --
      // so it is read as a construction, which resolves to the type's definition.
      calls: ['explicit_component_inst'],
      constructs: ['explicit_component_inst'],
      calleeFields: ['id'],
    },
  },
  tlaplus: {
    label: 'tlaplus',
    grammar: 'tree-sitter-tlaplus.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['operator_definition'],
    symbols: ['module', 'operator_definition'],
    containers: ['module'],
    relations: {
      // Applying an operator is TLA+'s call: `Next == Helper(x)`.
      calls: ['bound_op'],
      calleeFields: ['name'],
      imports: ['extends'],
    },
  },
  // Vue's grammar sees <template>, <script> and <style>; the script body is
  // opaque text to it. The chunker re-parses that text with the JavaScript or
  // TypeScript grammar, which is where the component's names actually are.
  vue: {
    label: 'vue',
    grammar: 'tree-sitter-vue.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['template_element', 'script_element', 'style_element'],
    symbols: [],
  },
  // Data and markup. There is nothing here that "declares" in the sense a code
  // graph means, so they record no symbols -- but the grammar still knows where
  // one rule, table or top-level key ends, which is a better cut than a
  // character count landing mid-block. Small neighbours are packed together so
  // a package.json does not become thirty one-line chunks.
  css: {
    label: 'css',
    grammar: 'tree-sitter-css.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['rule_set', 'media_statement', 'keyframes_statement', 'supports_statement', 'at_rule'],
    pack: true,
  },
  html: {
    label: 'html',
    grammar: 'tree-sitter-html.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['element', 'script_element', 'style_element'],
    containers: ['document'],
    pack: true,
  },
  json: {
    label: 'json',
    grammar: 'tree-sitter-json.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['pair'],
    containers: ['document', 'object'],
    pack: true,
  },
  toml: {
    label: 'toml',
    grammar: 'tree-sitter-toml.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['table', 'table_array_element', 'pair'],
    pack: true,
  },
  embedded_template: {
    label: 'embedded_template',
    grammar: 'tree-sitter-embedded_template.wasm',
    mode: 'AST_DECLARATION',
    boundaries: ['directive', 'output_directive', 'content'],
    pack: true,
  },
  // The next three load from `grammars/` in this package, not from
  // tree-sitter-wasms: its builds of them cannot be loaded by any current
  // runtime (Elm is ABI 12, QL ABI 10, YAML calls a scanner symbol nothing
  // exports). The vendored files come from each grammar's own repository; the
  // README there records source, commit and checksum.
  elm: {
    label: 'elm',
    grammar: 'tree-sitter-elm.wasm',
    vendored: true,
    mode: 'AST_DECLARATION',
    // A type annotation is filler, so it rides along with the value it annotates.
    boundaries: ['type_declaration', 'type_alias_declaration', 'value_declaration', 'port_annotation'],
    symbols: [
      'module_declaration', 'type_declaration', 'type_alias_declaration',
      'value_declaration', 'port_annotation',
    ],
    variables: ['value_declaration'],
    relations: {
      calls: ['function_call_expr'],
      calleeFields: ['target'],
      imports: ['import_clause'],
      importSource: 'moduleName',
    },
  },
  ql: {
    label: 'ql',
    grammar: 'tree-sitter-ql.wasm',
    vendored: true,
    mode: 'AST_DECLARATION',
    boundaries: ['module', 'dataclass', 'classlessPredicate', 'select'],
    symbols: ['module', 'dataclass', 'classlessPredicate', 'memberPredicate'],
    containers: ['moduleMember'],
    relations: {
      calls: ['call_or_unqual_agg_expr', 'qualifiedRhs'],
      imports: ['importDirective'],
      // The base type is a field of the class, not a clause of its own; asking
      // for the node would take the class's own name with it.
      heritageFields: ['extends'],
    },
  },
  yaml: {
    label: 'yaml',
    grammar: 'tree-sitter-yaml.wasm',
    vendored: true,
    mode: 'AST_DECLARATION',
    boundaries: ['block_mapping_pair', 'block_sequence_item'],
    containers: ['stream', 'document', 'block_node', 'block_mapping', 'block_sequence'],
    pack: true,
  },
  markdown: { label: 'markdown', grammar: null, mode: 'MARKDOWN_HEADING', boundaries: [] },
  text: { label: 'text', grammar: null, mode: 'CHARACTER', boundaries: [] },
};

const BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  // TSX needs its own grammar: the TypeScript one cannot read JSX, so `.tsx`
  // mapped to it parsed every component into an error node.
  '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c_sharp', '.csx': 'c_sharp',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala', '.sc': 'scala',
  '.swift': 'swift',
  '.dart': 'dart',
  '.php': 'php', '.phtml': 'php',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h++': 'cpp',
  '.m': 'objc', '.mm': 'objc',
  '.lua': 'lua',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.ex': 'elixir', '.exs': 'elixir',
  '.ml': 'ocaml', '.mli': 'ocaml',
  '.zig': 'zig',
  '.sol': 'solidity',
  '.res': 'rescript', '.resi': 'rescript',
  '.el': 'elisp',
  '.rdl': 'systemrdl',
  '.tla': 'tlaplus',
  '.vue': 'vue',
  '.css': 'css',
  '.html': 'html', '.htm': 'html',
  '.json': 'json',
  '.toml': 'toml',
  '.erb': 'embedded_template', '.ejs': 'embedded_template',
  '.elm': 'elm',
  '.ql': 'ql', '.qll': 'ql',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
};

/** The rule for a label, for callers that already know the language. */
export function ruleFor(label: string): LanguageRule | null {
  return RULES[label] ?? null;
}

/**
 * Languages whose grammar this build reads relations from, and those it does
 * not. A language in the second list still gets declarations and chunks; it
 * contributes no calls, and `doctor` says so rather than letting a repository
 * look like it makes none.
 */
export function relationLanguages(): { with: string[]; without: string[] } {
  const withRelations: string[] = [];
  const without: string[] = [];
  for (const rule of Object.values(RULES)) {
    // A language that declares nothing calls nothing: JSON and CSS are cut on
    // their structure and belong in neither list.
    if (!rule.grammar || !rule.symbols?.length) continue;
    (rule.relations?.calls?.length ? withRelations : without).push(rule.label);
  }
  return { with: withRelations, without };
}

/** Every language with a grammar, for the capability report. */
export function astLanguages(): string[] {
  return Object.values(RULES).filter((rule) => rule.grammar).map((rule) => rule.label);
}

export function ruleForFile(filePath: string): LanguageRule {
  const label = BY_EXTENSION[path.extname(filePath).toLowerCase()];
  return (label && RULES[label]) || RULES.text!;
}

interface TreeSitterModule {
  init(): Promise<void>;
  Language: { load(path: string): Promise<unknown> };
  Parser: new () => TreeSitterParser;
}

export interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(source: string): unknown;
  delete?: () => void;
}

/** A grammar and the runtime instance it was loaded into. They only work together. */
interface LoadedGrammar {
  Parser: TreeSitterModule['Parser'];
  language: unknown;
}

const grammars = new Map<string, Promise<LoadedGrammar | null>>();
/** Set once web-tree-sitter has failed; every later load returns null quietly. */
let runtimeFailure: string | null = null;

/**
 * How many parsers a grammar's runtime may hand out before it is thrown away.
 *
 * Each grammar gets a runtime of its own -- a whole WebAssembly instance -- and
 * they were never released, so a long scan ended with one live heap per
 * language in the repository. On a repository of three thousand files that ran
 * out: `new Parser()` aborted, and because the failed runtime stayed cached,
 * every later file of that language failed the same way. Four hundred shell
 * scripts lost their declarations to it, with nothing on stdout to say so.
 *
 * Recycling bounds it: past this many parsers the cached runtime is dropped and
 * the next call loads the grammar into a new one. The number is a budget, not a
 * measurement -- high enough that a normal file costs nothing, low enough that
 * no runtime lives long enough to fill up.
 */
const RECYCLE_AFTER = Math.max(
  1,
  Number.parseInt(process.env.MEMORY_LAYER_GRAMMAR_RECYCLE ?? '', 10) || 120,
);

const parsersHandedOut = new Map<string, number>();

/**
 * How many times each grammar has been loaded into a runtime of its own.
 *
 * Exported because the recycle is otherwise invisible: a test that only checks
 * that parsing still works passes just as well when nothing is ever recycled,
 * which is the bug. This counts the thing the fix actually changes.
 */
const grammarLoads = new Map<string, number>();

export function grammarLoadCounts(): Record<string, number> {
  return Object.fromEntries(grammarLoads);
}

/** Languages whose parser stopped being constructible part-way through a run. */
const lostParsers = new Map<string, { failures: number; reason: string }>();

/**
 * Which languages lost their parser during this process, and how often.
 *
 * Callers report this with their result. A scan that quietly drops every file
 * of one language is the failure this package exists to avoid, and a warning
 * in a log file nobody opens is not reporting it.
 */
export function lostParserLanguages(): Array<{ language: string; failures: number; reason: string }> {
  return [...lostParsers].map(([language, state]) => ({ language, ...state }))
    .sort((a, b) => b.failures - a.failures || a.language.localeCompare(b.language));
}

/** Test seam: forget what this process has learned about grammars. */
export function resetGrammarState(): void {
  grammars.clear();
  parsersHandedOut.clear();
  lostParsers.clear();
  grammarLoads.clear();
  runtimeFailure = null;
}

function grammarDir(): string | null {
  try {
    return `${path.dirname(require.resolve('tree-sitter-wasms/package.json'))}/out`;
  } catch {
    return null;
  }
}

/**
 * Keeps grammar code on V8's baseline compiler.
 *
 * Grammars are enormous straight-line functions -- a lexer is one switch with
 * thousands of cases, a start-up function applies one relocation per pointer
 * in the parse tables. Once hot, V8 hands them to its optimising compiler,
 * which needs hundreds of megabytes each. Measured on the default settings:
 * four grammars cost 401 MB, thirteen 673 MB, and the twenty-fourth killed the
 * process with "Fatal process out of memory: Zone" -- an abort, not an
 * exception, so there is nothing to catch and nothing to fall back to.
 *
 * Raising the tiering budget only moved the crash: budgets of 1e8 to 2e9 all
 * still died, later the larger they were, because parsing spends the budget.
 * The filter below is checked at the moment of tier-up, so it holds however
 * long the process parses. Nothing is re-optimised; parsing is about 1.65x
 * slower (400 C# classes: 535 ms to 900 ms per 40 parses), small next to
 * embedding. The flag is process-wide, but nothing else in this process runs
 * WebAssembly -- the embedder is ONNX Runtime's native build -- and it changes
 * only how fast code runs, never what it computes.
 */
let tieringCapped = false;
function capTiering(): void {
  if (tieringCapped) return;
  tieringCapped = true;
  try {
    // "Only tier up the function with this index": an index no module has.
    v8.setFlagsFromString('--wasm-tier-up-filter=2147483647');
  } catch (err) {
    log('warn', 'could not stop WebAssembly tier-up; loading many grammars may exhaust memory', err);
  }
}

/**
 * A fresh web-tree-sitter runtime, one per grammar.
 *
 * Grammars are linked into the runtime that loads them, and the old grammars
 * this package ships export helper functions under the same names. Loaded into
 * one shared runtime, a later grammar's scanner calls an earlier grammar's
 * helper: PHP loaded before Lua made Lua parse `function charge() end` into
 * ERROR nodes, so Lua files silently lost declarations -- only in a repository
 * that also had PHP, and only depending on which file came first. A runtime of
 * its own gives each grammar its own symbol table.
 *
 * The module is evaluated afresh for each, by dropping it from the require
 * cache; nothing else in this process holds on to it.
 */
async function freshRuntime(): Promise<{ Parser: TreeSitterModule['Parser']; Language: TreeSitterModule['Language'] } | null> {
  if (runtimeFailure !== null) return null;

  // An operator switch, and the seam the capability probe is tested through.
  if (process.env.MEMORY_LAYER_DISABLE_AST === '1') {
    runtimeFailure = 'disabled';
    log('info', 'AST chunking disabled by MEMORY_LAYER_DISABLE_AST=1');
    return null;
  }

  let module: Record<string, unknown>;
  try {
    const entry = require.resolve('web-tree-sitter');
    delete require.cache[entry];
    module = require(entry) as Record<string, unknown>;
  } catch (err) {
    runtimeFailure = 'unavailable';
    log('warn', 'web-tree-sitter unavailable; chunking falls back to character windows', err);
    return null;
  }

  try {
    // Three export shapes, all accepted so the pin can move. 0.22 and older
    // export the Parser class directly with `init` on it. 0.24 exports a
    // namespace with a top-level `init`. 0.25 exports a namespace too, but
    // `init` moved onto `Parser` as a static -- and code that only knew the
    // 0.24 shape called `undefined.call`, caught the TypeError, and turned AST
    // chunking off with nothing but a log line. Upgrading the runtime would
    // have silently downgraded every language to character windows.
    const asParser = typeof module === 'function' ? (module as unknown as TreeSitterModule) : null;
    const namespaceParser = module.Parser as (TreeSitterModule['Parser'] & { init?: () => Promise<void> }) | undefined;
    const owner = asParser ?? (typeof module.init === 'function' ? module : namespaceParser);
    const init = (owner as { init?: () => Promise<void> } | undefined)?.init;
    if (typeof init !== 'function') {
      runtimeFailure = 'shape';
      log('warn', 'web-tree-sitter exposes no init(); falling back to character chunking');
      return null;
    }
    await init.call(owner);

    const Parser = (asParser ?? namespaceParser) as TreeSitterModule['Parser'];
    const Language =
      ((asParser as unknown as TreeSitterModule)?.Language ??
        (module.Language as TreeSitterModule['Language']));

    if (typeof Parser !== 'function' || !Language) {
      runtimeFailure = 'shape';
      log('warn', 'web-tree-sitter exports an unexpected shape; falling back to character chunking');
      return null;
    }
    return { Parser, Language };
  } catch (err) {
    runtimeFailure = 'init';
    log('warn', 'web-tree-sitter failed to initialise', err);
    return null;
  }
}

/**
 * Loads a grammar into a runtime of its own, returning null when it is unavailable.
 *
 * Null is a normal answer, not an error: the chunker falls back to character
 * windows, so a missing or broken grammar costs chunk quality and nothing else.
 */
function loadGrammar(rule: LanguageRule): Promise<LoadedGrammar | null> {
  if (!rule.grammar) return Promise.resolve(null);
  let pending = grammars.get(rule.label);
  if (!pending) {
    pending = loadGrammarUncached(rule, rule.grammar);
    grammars.set(rule.label, pending);
  }
  return pending;
}

async function loadGrammarUncached(rule: LanguageRule, grammar: string): Promise<LoadedGrammar | null> {
  grammarLoads.set(rule.label, (grammarLoads.get(rule.label) ?? 0) + 1);
  // dist/ingest/languages.js -> <package>/grammars
  const dir = rule.vendored ? fileURLToPath(new URL('../../grammars', import.meta.url)) : grammarDir();
  if (!dir) {
    log('warn', 'tree-sitter-wasms not resolvable; chunking falls back to character windows');
    return null;
  }
  const file = path.join(dir, grammar);
  if (!fs.existsSync(file)) {
    log('warn', `grammar missing: ${file}`);
    return null;
  }

  capTiering();
  const runtime = await freshRuntime();
  if (!runtime) return null;

  try {
    const language = await runtime.Language.load(file);
    return { Parser: runtime.Parser, language };
  } catch (err) {
    log('warn', `failed to load grammar ${rule.label}`, err);
    return null;
  }
}

/**
 * A new parser for a language, or null. The caller owns it and should call
 * `delete()` when done: it lives in WebAssembly memory the garbage collector
 * cannot see.
 */
export async function newParser(rule: LanguageRule): Promise<TreeSitterParser | null> {
  const loaded = await loadGrammar(rule);
  if (!loaded) return null;

  try {
    // A seam, like MEMORY_LAYER_DISABLE_AST: the interesting failure is a
    // runtime that has run out of memory, and there is no way to ask a healthy
    // one to do that. Naming a language here makes its next parser throw, so
    // the recovery path -- drop the dead runtime, record which language stopped
    // being read -- is exercised rather than assumed.
    if (process.env.MEMORY_LAYER_FAIL_PARSER === rule.label) {
      throw new Error('Aborted(). (fault injection via MEMORY_LAYER_FAIL_PARSER)');
    }
    const parser = new loaded.Parser();
    parser.setLanguage(loaded.language);

    // Count what this runtime has produced, and retire it once it has done
    // enough. Dropping the cache entry is the whole retirement: the parsers and
    // trees are deleted by their callers, so nothing else holds the module and
    // it can be collected.
    const handedOut = (parsersHandedOut.get(rule.label) ?? 0) + 1;
    if (handedOut >= RECYCLE_AFTER) {
      grammars.delete(rule.label);
      parsersHandedOut.delete(rule.label);
    } else {
      parsersHandedOut.set(rule.label, handedOut);
    }
    return parser;
  } catch (err) {
    // A runtime that cannot make a parser will not make the next one either.
    // Drop it so the language gets a fresh one, and record the loss so the
    // command can say which language it stopped indexing.
    grammars.delete(rule.label);
    parsersHandedOut.delete(rule.label);
    const previous = lostParsers.get(rule.label);
    lostParsers.set(rule.label, {
      failures: (previous?.failures ?? 0) + 1,
      reason: err instanceof Error ? err.message : String(err),
    });
    log('warn', `failed to construct parser for ${rule.label}`, err);
    return null;
  }
}

/**
 * Whether a language can actually be parsed right now.
 *
 * A predicate, deliberately, rather than something the caller learns by catching
 * an exception. "There is no parser" is a state worth being able to ask about;
 * discovering it from a swallowed throw is how the AST chunker ran as a
 * character chunker for its entire existence without anything looking wrong.
 */
export async function isLanguageAvailable(label: string): Promise<boolean> {
  const rule = RULES[label];
  if (!rule || !rule.grammar) return false;
  const wasLoaded = grammars.has(rule.label);
  const parser = await newParser(rule);
  parser?.delete?.();
  // A grammar loaded only to answer this question is let go again. `doctor`
  // asks about all of them, and a long-lived process that runs it should not
  // keep thirty-six runtimes for the languages its repository never uses.
  if (!wasLoaded) grammars.delete(rule.label);
  return parser !== null;
}

/**
 * Whether AST chunking works on this machine, checked once against a known-good
 * snippet so the answer is about the toolchain rather than about one file.
 *
 * Recorded into `capabilities` at init, which is what makes a silent fallback to
 * character windows visible in `doctor` on every machine -- rather than only
 * where somebody remembered to write a test for it.
 */
export async function probeAstChunking(): Promise<AstCapability> {
  const rule = RULES.typescript!;
  const available: string[] = [];

  const parser = await newParser(rule);
  if (!parser) {
    // Turned off on purpose is a different report from broken. Both mean worse
    // chunks, but only one is something to go and fix.
    const disabled = process.env.MEMORY_LAYER_DISABLE_AST === '1';
    return {
      provider: 'web-tree-sitter',
      status: disabled ? 'degraded' : 'unavailable',
      reason: disabled
        ? 'Disabled by MEMORY_LAYER_DISABLE_AST=1; chunking uses character windows.'
        : 'Could not construct a parser, so chunking falls back to character windows ' +
          'and chunks will not follow declaration boundaries.',
      languages: [],
    };
  }

  try {
    const tree = parser.parse('function probe() { return 1; }') as {
      rootNode: { children: { type: string }[] };
    };
    if (!tree.rootNode.children.some((child) => child.type === 'function_declaration')) {
      return {
        provider: 'web-tree-sitter',
        status: 'degraded',
        reason:
          'A parser was built but did not recognise a function declaration, so ' +
          'declaration boundaries cannot be trusted.',
        languages: [],
      };
    }
  } catch (err) {
    return {
      provider: 'web-tree-sitter',
      status: 'unavailable',
      reason: `Parsing a known-good snippet failed: ${err instanceof Error ? err.message : String(err)}`,
      languages: [],
    };
  }

  for (const label of Object.keys(RULES)) {
    if (RULES[label]?.grammar && (await isLanguageAvailable(label))) available.push(label);
  }

  return {
    provider: 'web-tree-sitter',
    status: 'available',
    reason: `Declaration-boundary chunking for ${available.length} languages.`,
    languages: available,
  };
}

export interface AstCapability {
  provider: string;
  status: 'available' | 'unavailable' | 'degraded';
  reason: string;
  languages: string[];
  [extra: string]: unknown;
}

export const KNOWN_LANGUAGES = Object.keys(RULES);
