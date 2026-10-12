# Solidity Workbench

Productivity tools for Solidity in VS Code, starting with Foundry projects. The goal is to make working with Solidity feel as comfortable as working with TypeScript.

The first feature is **auto-import**: start typing the name of any contract, interface, library, struct, enum, error, event, user-defined value type, free function or file-level constant from your project or its dependencies, accept the suggestion, and the import is added for you.

```solidity
contract Vault is Ownab|
//               Ownable   @openzeppelin/contracts/access/Ownable.sol
```

After accepting:

```solidity
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Vault is Ownable
```

## Features

### Auto-import in completions

- Suggests top-level symbols that are not yet in scope, with the import path shown next to the name.
- Adds a named import (`import {X} from "...";`) after the pragma and the last existing import.
- If the file already imports something from the same file, the new name is merged into it: `import {A, Ownable} from "...";`. Multi-line import lists, quote style and line endings are kept as they are.
- No suggestions inside comments or strings, nor for names already declared or imported in the file.
- When the same name exists in several files (e.g. nested copies in `lib/x/lib/y`), each distinct file gets its own suggestion. The ranking is:
  1. your own files, and files reached through a declared remapping (e.g. `@openzeppelin/contracts/`);
  2. files reached through an inferred remapping (`name/=lib/name/src/`);
  3. files only reachable through a relative path;
  4. within each tier, the least nested copy first.
- From files in `src/`, symbols defined in `test/` and `script/` are not suggested. From `test/` and `script/`, everything is.

### Quick fix

On an *undeclared identifier* diagnostic (solc errors 7576 and 7920, whichever extension reports them), the light bulb offers `Import X from "..."` for each matching file.

### Add Solidity Import command

`Solidity Workbench: Add Solidity Import` opens a searchable list of every indexed symbol, prefilled with the word under the cursor. It also accepts arguments, for keybindings:

```json
{
  "key": "ctrl+alt+i",
  "command": "solidityWorkbench.addImport",
  "args": { "name": "Ownable" }
}
```

### Syntax diagnostics

Syntax errors are reported as you type, without saving, with messages meant for people:

- `contact Vault {}` → *Unknown keyword `contact`. Did you mean `contract`?*, with a quick fix. Misspelled declaration keywords are only reported where the code could never be valid, so a type named `Contact` is never flagged.
- A forgotten `}` in the middle of a file → *Missing `}` to close `function deposit` (opened on line 12)*. Indentation is used to find the block that was really left open, not just the last one.
- Extra or mismatched brackets, and the first parser error (*Missing `;`*, *Unexpected `)`*...). Errors that only follow from an earlier one are not repeated.

Analysis runs in a background thread. Type errors, unknown names and other compiler checks are not part of this layer.

### Outline

The Outline view, breadcrumbs and *Go to Symbol in Editor* (`Ctrl+Shift+O` / `Cmd+Shift+O`) list contracts, interfaces and libraries with their functions, modifiers, events, errors, state variables, structs and enums, plus file-level declarations. The outline keeps working while the file has syntax errors.

### Navigation

- **Go to Definition** (`F12`, `Ctrl/Cmd+click`) on:
  - names declared in the file or imported, following aliases (`import {A as B}`), plain imports (`import "x.sol"`) and re-exports across files;
  - members of the current contract and of the contracts it inherits from, in any file (`onlyOwner`, `_msgSender`, inherited errors and events), with `super.` and `this.`;
  - qualified names: `Math.max` (every overload), `Errors.Unauthorized`, `Types.Side.Long`, `Alias.Symbol` for `import * as Alias`.
- **Import paths are links**: `Ctrl/Cmd+click` on `"@openzeppelin/contracts/access/Ownable.sol"` opens the file, resolved with the project's remappings.
- **Go to Symbol in Workspace** (`Ctrl/Cmd+T`) searches the top-level symbols of every indexed project, dependencies included.

Unsaved changes in open files are taken into account.

### Formatting (optional)

Formats with `forge fmt`, so the `[fmt]` section of your `foundry.toml` applies. It is **off by default**, since many people prefer to run `forge fmt` themselves. To use it, set `solidityWorkbench.formatting.enabled` to `true` and pick it as the formatter:

```json
"[solidity]": { "editor.defaultFormatter": "local.solidity-workbench" }
```

If the file has a syntax error, nothing is changed and the reason is shown in the status bar. forge prints partially formatted code in that case, and that output is never applied.

### Other commands

- `Solidity Workbench: Rebuild Symbol Index`: discards the cache and re-indexes every project.
- `Solidity Workbench: Show Log`: indexing statistics and the remappings in use.

## Installation

From a `.vsix`:

```bash
code --install-extension solidity-workbench-0.1.0.vsix
```

From source:

```bash
npm install
npm run package
```

Requirements: VS Code 1.90 or newer. [Foundry](https://getfoundry.sh) is recommended but not required (see *Remappings* below).

### Working alongside other Solidity extensions

Solidity Workbench does not register a grammar, and works with or without other Solidity extensions installed: it handles every `*.sol` file whatever its language id. Features that another extension also provides may conflict with it (for example, duplicated suggestions or diagnostics); every feature can be turned off with its `solidityWorkbench.<feature>.enabled` setting.

## How it works

### Projects

Each `.sol` file belongs to the nearest ancestor folder containing a `foundry.toml`. A `foundry.toml` that lives in a dependency (inside one of the enclosing project's `libs`, such as `lib/openzeppelin-contracts`) does not start a new project. Monorepos with several Foundry projects and multi-root workspaces are therefore supported. A file outside any Foundry project is indexed with its workspace folder as the root.

The `src`, `test`, `script` and `libs` settings of `foundry.toml` are honoured, including the profile in `FOUNDRY_PROFILE`.

### Remappings

Remappings come from `forge remappings`, run in the project root. forge is looked up on the `PATH` and then in `$FOUNDRY_DIR/bin` and `~/.foundry/bin` (where foundryup installs it, often missing from the `PATH` VS Code sees), unless `solidityWorkbench.foundry.forgePath` is set. `Solidity Workbench: Show Log` shows which forge was used and the resulting remappings.

When forge is not available, they are built following forge's own rules (checked against forge 1.x by a test that compares both on several layouts):

1. `remappings` in `foundry.toml`, then `remappings.txt`; these hide any inferred remapping with the same prefix;
2. for each library, `name/` → `lib/name/src/` (or `contracts/`, or the library root when it has no `lib/` of its own), recursively;
3. the remappings a library declares in its `remappings.txt` / `foundry.toml`, when the library has a `foundry.toml`;
4. the shallowest library wins a prefix; a nested library that loses it keeps it scoped to its parent (`lib/parent/:name/=...`).

For each file, the remapping with the longest matching target is used and checked to resolve back to the same file. Remapping contexts (`context:prefix=target`) are respected. If no remapping covers the file, the import uses a relative path.

### Index

The index covers `src/`, `test/`, `script/`, the library folders and any remapping target in the project (e.g. `node_modules/@openzeppelin/...`). Files are parsed with `@solidity-parser/parser` in tolerant mode, with a regex fallback for files it cannot handle. Parsing happens in a pool of worker threads, so the editor stays responsive. Results are cached on disk by modification time, and kept up to date with file system watchers, including `forge install` and changes to `foundry.toml` or `remappings.txt`.

As a reference, a synthetic project with 5,651 files (13 copies of OpenZeppelin Contracts) indexes in about 14 s cold and about 0.4 s from cache, without blocking the extension host. A completion query takes between 0.4 ms and 40 ms, depending on how much has been typed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `solidityWorkbench.autoImport.enabled` | `true` | Enables the auto-import feature (completions, quick fix, command). |
| `solidityWorkbench.autoImport.pathStyle` | `"remapped"` | `remapped`: use a remapping when one covers the file, else a relative path. `relative`: always relative paths. |
| `solidityWorkbench.syntaxDiagnostics.enabled` | `true` | Report syntax errors while typing. |
| `solidityWorkbench.outline.enabled` | `true` | Provide the document outline. |
| `solidityWorkbench.navigation.enabled` | `true` | Go to Definition, clickable import paths and Go to Symbol in Workspace. |
| `solidityWorkbench.formatting.enabled` | `false` | Format with `forge fmt`. |
| `solidityWorkbench.index.includeTests` | `true` | Index the project's test folder. |
| `solidityWorkbench.index.includeScripts` | `true` | Index the project's script folder. |
| `solidityWorkbench.index.excludeLibTestsAndMocks` | `true` | Skip `test`, `tests`, `mock` and `mocks` folders inside libraries. |
| `solidityWorkbench.index.exclude` | `[]` | Glob patterns (relative to the project root) of files to leave out, e.g. `["lib/**/certora/**"]`. |
| `solidityWorkbench.foundry.forgePath` | `"forge"` | Path to the forge executable. With the default, `~/.foundry/bin/forge` is also tried. |

Each feature has its own `solidityWorkbench.<feature>.enabled` setting; the `index.*` and `foundry.*` settings belong to the shared core that future features will also use.

## Known limitations

- Only top-level declarations are indexed. Members such as `Contract.Struct` or `Library.function` are not suggested on their own.
- The index reflects files on disk: symbols added to another file appear once it is saved.
- `import "x.sol";` puts every symbol of `x.sol` in scope and those are not suggested again. Symbols that `x.sol` itself imports, which solc also brings into scope, may still be suggested.
- Without forge, remappings are inferred with forge's main rules; unusual setups may differ. Install forge, or add a `remappings.txt`, for exact results.
- Projects without `foundry.toml` (e.g. Hardhat-only) are indexed with Foundry's default layout, so `contracts/` and `node_modules` are only covered when a remapping points at them.
- The import quick fix needs another extension that reports solc diagnostics; on its own, Solidity Workbench does not compile yet.
- Go to Definition does not resolve local variables, parameters, or members accessed through a value (`token.transfer`): that needs type information. Inherited members are searched in declaration order, without solc's exact linearization for diamond hierarchies.
- Go to Symbol in Workspace lists top-level symbols only.
- Syntax diagnostics may duplicate those of another Solidity extension. Turn off `solidityWorkbench.syntaxDiagnostics.enabled`, or the equivalent in the other extension.
- Another Solidity extension with its own completions or auto-import may conflict with this one and show a similar suggestion next to ours. Disable the feature in one of them if this is distracting.
- Without any Solidity extension, the workbench starts when the workspace contains a `.sol` file or a `foundry.toml`. A loose `.sol` file opened outside any workspace does not activate it.
- Deleting a folder other than a library may leave its symbols in the index until the next reload or `Rebuild Symbol Index`, depending on how the file watcher reports the deletion on your platform.

## Development

```bash
npm install
npm run build            # esbuild bundle in dist/
npm run typecheck
npm run test:unit        # vitest, pure logic, no editor
npm run test:integration # @vscode/test-electron on test/fixtures/foundry-project
npm run package          # .vsix
```

Press F5 with *Run Extension (fixture project)* to open the fixture in an Extension Development Host. `node test/bench/indexBench.mjs <projectRoot> . <out.cjs>` (after `npm run build`) benchmarks indexing on a large project.

Layout:

- `src/core/`: pure logic, with no `vscode` imports: the project model, remappings, the symbol extraction, the index, the cache, import edits and candidate ranking.
- `src/host/`: the VS Code adapters of the core: settings, logging, project discovery, watchers.
- `src/features/<feature>/`: one folder per feature, each registering itself through the `FeatureRegistry`: `autoImport`, `syntaxDiagnostics`, `outline`, `navigation`, `formatting`.
