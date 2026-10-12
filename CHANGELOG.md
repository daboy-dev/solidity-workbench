# Changelog

## Unreleased

- Syntax diagnostics while typing: misspelled keywords (with a quick fix), unbalanced brackets pointing at the block left open, readable parser errors.
- Document outline for Solidity files.

## 0.1.0

- Auto-import of top-level Solidity symbols in completions, for Foundry projects and their dependencies.
- "Import X from ..." quick fix on undeclared identifier diagnostics.
- "Add Solidity Import" command.
- Shared core: Foundry project model, remappings (`forge remappings` with file-based fallback) and a background symbol index cached on disk.
