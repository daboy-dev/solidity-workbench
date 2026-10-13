# Changelog

## 0.3.0 — 2026-10-13

- Language completion, also on half-written code:
  - types and keywords that fit the context (declarations, function headers, statements, expressions), with `address` first for `add`;
  - parameters, local variables, contract members (inherited from other files too) and imported names, ranked by the expected type and name;
  - in `Struct({ ... })`, the missing fields left of `:` and matching values right of it, also for functions, events and errors;
  - members after `.`: `msg`, `block`, `tx`, `abi`, `type(X)`, addresses, arrays, struct fields, functions of contract-typed values, `this`, `super`, libraries, enums;
  - global functions and units; availability and deprecations follow the file's solc version (`prevrandao`, `blobbasefee`, `transient`, `transfer`/`send` deprecated from 0.8.31).
- Language suggestions rank before auto-import ones, and names already in scope are no longer offered for import.
- Syntax diagnostics report trailing commas, with a quick fix to remove them.
- Quick fixes for a missing data location (solc 6651).

## 0.2.0 — 2026-10-13

- Syntax diagnostics while typing: misspelled keywords (with a quick fix), unbalanced brackets pointing at the block left open, readable parser errors.
- Compiler diagnostics while typing with the solc installed by forge, on unsaved changes, filtered like `forge build`; keyword hints for misspelled identifiers.
- Document outline for Solidity files.
- Go to Definition across files (imports, aliases, inheritance, `Library.member`, `using ... for` libraries), clickable import paths and Go to Symbol in Workspace.
- Optional formatter backed by `forge fmt` (off by default).
- forge is also found in `~/.foundry/bin` when it is not on the `PATH`; the remapping fallback follows forge's rules.
- Extension icon.

## 0.1.0

- Auto-import of top-level Solidity symbols in completions, for Foundry projects and their dependencies.
- "Import X from ..." quick fix on undeclared identifier diagnostics.
- "Add Solidity Import" command.
- Shared core: Foundry project model, remappings (`forge remappings` with file-based fallback) and a background symbol index cached on disk.
