# Vendored grammars

Five grammars that `tree-sitter-wasms` ships but that do not work from it. Its
builds are old: `tree-sitter-elm.wasm` targets grammar ABI 12 and
`tree-sitter-ql.wasm` ABI 10, while web-tree-sitter 0.25 accepts 13 to 15.
`tree-sitter-yaml.wasm` loads, then calls a scanner function that no runtime
exports ("resolved is not a function"). `tree-sitter-bash.wasm` does the same on
any `case ... in`, and the runtime aborts afterwards -- so nearly every real shell
script lost its declarations. `tree-sitter-lua.wasm` loads and parses
correctly exactly once: every later parse in the same runtime, even of the same
source with a fresh parser, returns ERROR nodes. `tree-sitter-wasms` 0.1.13 is
the latest release, so an upgrade does not fix them.

The files below come from each grammar's own repository, built by its
maintainers, and are loaded in place of the broken ones. Each was loaded with
web-tree-sitter 0.25.10, parsed a sample with no error nodes, and returned the
same tree on four consecutive parses.

| File | Source | Version | Commit | SHA-256 | Licence |
|---|---|---|---|---|---|
| `tree-sitter-bash.wasm` | [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash), release asset (SHA-256 matches the digest GitHub publishes for it) | v0.25.1 | `a06c2e4415e9bc0346c6b86d401879ffb44058f7` | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` | MIT |
| `tree-sitter-elm.wasm` | [elm-tooling/tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm), `docs/js/tree-sitter-elm.wasm` (the playground build, regenerated in the release commit alongside `src/parser.c`) | v5.9.4 | `34815684e37cf299477e86a7d1e10d3ecb5486f9` | `f5be719060c3583943ba829333a878c43255da2921dd93a8ef305e8f6bb746cb` | MIT |
| `tree-sitter-lua.wasm` | [tree-sitter-grammars/tree-sitter-lua](https://github.com/tree-sitter-grammars/tree-sitter-lua), release asset | v0.5.0 | `10fe0054734eec83049514ea2e718b2a56acd0c9` | `df08a1704e504c70b8dba4a3e6f8e0c99a4fb94e1b1693d2969f53141d09f0d4` | MIT |
| `tree-sitter-ql.wasm` | [tree-sitter/tree-sitter-ql](https://github.com/tree-sitter/tree-sitter-ql), release asset | v0.23.1 | `1fd627a4e8bff8c24c11987474bd33112bead857` | `f7f01c27f942a76ffceb30cb194fe669f81a21971126a57d9bf876bdaffa85dc` | MIT |
| `tree-sitter-yaml.wasm` | [tree-sitter-grammars/tree-sitter-yaml](https://github.com/tree-sitter-grammars/tree-sitter-yaml), release asset | v0.7.2 | `7708026449bed86239b1cd5bce6e3c34dbca6415` | `0a0e5ebcfeb0b2bf272d071396eeed107b2c4b2617b69d5959b13f78b357a4d6` | MIT |

Licence texts are in [`licenses/`](licenses/).

To refresh one, download the newer file from the same place, check that it
loads and parses cleanly, and update this table. The language rule in
`src/ingest/languages.ts` names node types measured against these exact files;
a newer grammar can rename them, so re-run the per-language check afterwards.
