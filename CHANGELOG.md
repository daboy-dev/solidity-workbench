# Changelog

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
