<img src="images/icon.png" width="96" alt="Solidity Workbench icon">

# Solidity Workbench

The usual Solidity extensions highlight the syntax, but miss the basics you take for granted in TypeScript: imports that write themselves, completion that knows your variables and types, errors before you save. Solidity Workbench adds them for Foundry projects, and works on its own or next to other Solidity extensions.

## Highlights

- **Auto-import**: complete any contract, library, struct, error… of your project or its dependencies, and the import is added with the right remapping.

  ```solidity
  contract Vault is Ownab|   // → Ownable, and import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
  ```

- **Completion that understands the code**, even half-written: variables and members in scope (inherited ones too), types and keywords that fit where you are, members after `.` (`msg.sender`, `order.amount`, `token.balanceOf`), and the missing fields when you create a struct, with matching values first:

  ```solidity
  struct Order {
      address buyer;
      uint256 amount;
      uint256 deadline;
  }

  Order memory order = Order({
      buyer: msg.sender,
      |                       // suggests the missing fields: amount, deadline
  });
  ```

  It follows the file's solc version: `block.prevrandao` from 0.8.18, `blobhash` from 0.8.24, `transfer` and `send` marked deprecated from 0.8.31.

- **Errors while you type, without saving**: solc's errors and warnings filtered exactly like `forge build`, and readable syntax errors (*Missing `}` to close `function deposit`*, *Did you mean `contract`?*), with quick fixes for misspelled keywords, missing imports, missing data locations and trailing commas.

- **Go to Definition that follows Solidity**: through imports and aliases, inheritance across files, `super.`, `Library.member` and `using … for` libraries.

Also included: document outline, Go to Symbol in Workspace and clickable import paths. See [all features in detail](docs/features.md).

## Installation

Install **Solidity Workbench** from the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), or from the command line:

```bash
code --install-extension daboy-dev.solidity-workbench
```

It is also on [Open VSX](https://open-vsx.org/extension/daboy-dev/solidity-workbench), for editors that use it instead of the Visual Studio Marketplace.

Requirements: VS Code 1.90 or newer. [Foundry](https://getfoundry.sh) is recommended: compiler diagnostics use the solc binaries forge installs, and remappings are read from `forge remappings` (inferred like forge does when it is missing).

## Optional features

These are off by default:

- **Formatting with `forge fmt`**, using the `[fmt]` section of your `foundry.toml`. Enable `solidityWorkbench.formatting.enabled` and pick it as the formatter:

  ```json
  "[solidity]": { "editor.defaultFormatter": "daboy-dev.solidity-workbench" }
  ```

## Performance

Parsing runs in background threads and solc in its own process, so the editor is never blocked for more than a few milliseconds. On a project with 5,651 files:

| Operation | Time |
| --- | --- |
| Completion | ~1 ms (auto-import: up to 40 ms on the first letters) |
| solc check of a contract importing ERC4626, AccessControl and Governor | ~40 ms |
| Go to Definition through OpenZeppelin's inheritance | under 1 ms (under 100 ms the first time) |
| Symbol index, first time / from cache | ~14 s / ~0.4 s, in the background |

More measurements and how each part works: [How it works](docs/how-it-works.md).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `solidityWorkbench.completion.enabled` | `true` | Suggest types, keywords, values in scope, struct fields, members after `.` and globals. |
| `solidityWorkbench.autoImport.enabled` | `true` | Enables the auto-import feature (completions, quick fix, command). |
| `solidityWorkbench.autoImport.pathStyle` | `"remapped"` | `remapped`: use a remapping when one covers the file, else a relative path. `relative`: always relative paths. |
| `solidityWorkbench.syntaxDiagnostics.enabled` | `true` | Report syntax errors while typing. |
| `solidityWorkbench.compilerDiagnostics.enabled` | `true` | Check files with solc while typing. |
| `solidityWorkbench.compilerDiagnostics.delay` | `400` | Milliseconds after the last keystroke before running solc. |
| `solidityWorkbench.compilerDiagnostics.ignoredCodes` | `[]` | Extra warning codes to hide (`2072` or `"unused-var"`), added to `ignored_error_codes`. |
| `solidityWorkbench.compiler.solcPath` | `""` | solc binary path or installed version to use instead of the automatic choice. |
| `solidityWorkbench.outline.enabled` | `true` | Provide the document outline. |
| `solidityWorkbench.navigation.enabled` | `true` | Go to Definition, clickable import paths and Go to Symbol in Workspace. |
| `solidityWorkbench.formatting.enabled` | `false` | Format with `forge fmt`. |
| `solidityWorkbench.index.includeTests` | `true` | Index the project's test folder. |
| `solidityWorkbench.index.includeScripts` | `true` | Index the project's script folder. |
| `solidityWorkbench.index.excludeLibTestsAndMocks` | `true` | Skip `test`, `tests`, `mock` and `mocks` folders inside libraries. |
| `solidityWorkbench.index.exclude` | `[]` | Glob patterns (relative to the project root) of files to leave out, e.g. `["lib/**/certora/**"]`. |
| `solidityWorkbench.foundry.forgePath` | `"forge"` | Path to the forge executable. With the default, `~/.foundry/bin/forge` is also tried. |

Each feature can be turned off with its own `enabled` setting; `index.*` and `foundry.*` configure the shared core.

## Known limitations

- Other Solidity extensions may show similar suggestions or diagnostics next to ours: turn the feature off in one of them.
- Compiler diagnostics need a solc installed by forge, or `solidityWorkbench.compiler.solcPath`.
- Library functions attached with `using … for` are not suggested after a value (`token.safeTransfer`); Go to Definition does find them.
- Projects without `foundry.toml` are indexed with Foundry's default layout.

[Full list](docs/features.md#known-limitations) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)
