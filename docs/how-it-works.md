# How it works

## Projects

Each `.sol` file belongs to the nearest ancestor folder containing a `foundry.toml`. A `foundry.toml` that lives in a dependency (inside one of the enclosing project's `libs`, such as `lib/openzeppelin-contracts`) does not start a new project. Monorepos with several Foundry projects and multi-root workspaces are therefore supported. A file outside any Foundry project is indexed with its workspace folder as the root.

The `src`, `test`, `script` and `libs` settings of `foundry.toml` are honoured, including the profile in `FOUNDRY_PROFILE`.

## Remappings

Remappings come from `forge remappings`, run in the project root. forge is looked up on the `PATH` and then in `$FOUNDRY_DIR/bin` and `~/.foundry/bin` (where foundryup installs it, often missing from the `PATH` VS Code sees), unless `solidityWorkbench.foundry.forgePath` is set. `Solidity Workbench: Show Log` shows which forge was used and the resulting remappings.

When forge is not available, they are built following forge's own rules (checked against forge 1.x by a test that compares both on several layouts):

1. `remappings` in `foundry.toml`, then `remappings.txt`; these hide any inferred remapping with the same prefix;
2. for each library, `name/` → `lib/name/src/` (or `contracts/`, or the library root when it has no `lib/` of its own), recursively;
3. the remappings a library declares in its `remappings.txt` / `foundry.toml`, when the library has a `foundry.toml`;
4. the shallowest library wins a prefix; a nested library that loses it keeps it scoped to its parent (`lib/parent/:name/=...`).

For each file, the remapping with the longest matching target is used and checked to resolve back to the same file. Remapping contexts (`context:prefix=target`) are respected. If no remapping covers the file, the import uses a relative path.

## Index

The index covers `src/`, `test/`, `script/`, the library folders and any remapping target in the project (e.g. `node_modules/@openzeppelin/...`). Files are parsed with `@solidity-parser/parser` in tolerant mode, with a regex fallback for files it cannot handle. Parsing happens in a pool of worker threads, so the editor stays responsive. Results are cached on disk by modification time, and kept up to date with file system watchers, including `forge install` and changes to `foundry.toml` or `remappings.txt`.

## Rename and references

Local variables and parameters are resolved with the tolerant parser used by completion: each use is bound to the innermost declaration visible at that point. A rename is applied to the text, parsed again and accepted only if exactly the renamed occurrences refer to the new name.

Everything else comes from solc's AST of the project's own files (`src`, `test`, `script`, with unsaved buffers), compiled in a worker thread: solc runs in its own process, and parsing the JSON (several megabytes) and indexing it never touches the extension host. Files are grouped by the solc version their pragmas and imports allow, as `forge build` does, and each group is compiled separately. solc produces no AST when anything fails, so files with errors (and the files importing them) are left out and the rest is compiled again; a rename or a reference search is refused or flagged only if a left-out file imports the symbol's file. Name positions come from `nameLocation`, `memberLocation` and `nameLocations` (solc ≥ 0.8.19), or from the source tokens on older versions; UTF-8 byte offsets are converted to UTF-16. The AST is cached until any file changes, and a compilation for older contents is cancelled.

A rename is planned from the AST (the symbol, its override hierarchy through `baseFunctions`, named arguments, aliases), then the renamed sources are compiled again and every reference must still point to the same declaration, now at its new position.

## Performance

Measured on a synthetic project with 5,651 files (13 copies of OpenZeppelin Contracts 5.6), with forge 1.8.5 and solc 0.8.37:

| Operation | Time |
| --- | --- |
| Index, first time / from cache | ~14 s / ~0.4 s, in background threads |
| Auto-import completion query | 0.4–40 ms, depending on how much has been typed |
| Language completion (scope, members, inherited functions)¹ | ~1 ms; the first request parses the files it inherits from (~17 ms for ERC4626 + AccessControl, 41 files) |
| Load project (`forge remappings` + `forge config`) | ~120 ms |
| Syntax analysis + outline of an 800-line file | ~65 ms, in a background thread |
| solc check of a contract importing ERC4626, AccessControl and Governor | ~40 ms (median) |
| Go to Definition through OpenZeppelin's inheritance | under 1 ms once the files are parsed, under 100 ms the first time |
| Rename of a local variable (worst case, a 13,000-line file) | under 25 ms, check included |
| Project AST for rename/references: 63 own files using OpenZeppelin² | ~190 ms (solc ~155 ms, JSON + index ~35 ms in the worker) |
| Rename a function used 181 times in 61 files² | ~190 ms, including the compilation that checks the result |
| Same with 303 own files (901 uses) | AST ~310 ms, rename ~305 ms; Find All References under 1 ms once compiled |

¹ Measured on a Foundry project with OpenZeppelin Contracts 5; it depends on the files the contract reaches, not on the size of the project.
² Generated test files, each importing the renamed contract and an ERC4626 + AccessControl vault; a rename runs `prepare` on the cached AST, then plans and checks the edits.

The extension host is never blocked for more than a few milliseconds: parsing runs in worker threads and solc in its own process, and a check in progress is cancelled when you keep typing. Language completion uses its own tolerant parser, linear and fast enough to run in place (2 ms for an 800-line file), and caches what it parses by document version and modification time.

The language benchmark (`test/bench/languageBench.ts`, see [CONTRIBUTING.md](../CONTRIBUTING.md)) reproduces these measurements on any Foundry project.
