# Changelog

## 0.6.1 — 2026-10-20

- Auto-import also offers errors, events, structs and enums declared inside contracts, interfaces and libraries, inserted qualified with their container imported (`IERC721Errors.ERC721NonexistentToken`); the undeclared-identifier quick fix does the same, and Go to Symbol in Workspace finds them. The symbol index is rebuilt once.
- After `emit` and `revert`, completion also suggests the contracts and interfaces that declare other events or errors, and after `emit Market.` / `revert Market.` only their events or errors; auto-import offers only events after `emit` and only errors after `revert`.
- `selector` is suggested, typed and hovered after errors and events, qualified or not (`vm.expectRevert(Market.PriceZero.selector)`).
- Misspelled `revert` and `emit` in function bodies (`revertr Unauthorized();`) and misspelled `using` (`uisng SafeERC20 for IERC20;`) are reported on the word, with a quick fix, instead of a parser error further on.

## 0.6.0 — 2026-10-15

- Signature help, on by default (`solidityWorkbench.signatureHelp.enabled`), without running solc: the parameter being filled with the NatSpec of the declaration and of each parameter, for functions and members, functions attached with `using ... for` (without the value they are called on), events after `emit`, errors after `revert`, struct constructors (positional or named arguments), `new C(...)` and allocations (`new bytes(n)`, `new uint256[](n)`), `T.wrap` / `T.unwrap`, modifiers and base constructors in headers, variables of function type and built-in functions. Every overload is listed, with the one the arguments reach selected.
- Functions attached with `using ... for` are resolved without compiling: suggested after a value (without their first parameter), typed in chained calls, and shown by hover and Go to Definition. Directives of the file, of the enclosing contract and `global` ones of the type's file apply, as in solc.
- Overloads are told apart by the types of the arguments, as solc does (number or names of arguments, implicit conversions, literals, derived contracts): hover shows the overload a call reaches, Go to Definition goes straight to it, calls take its return type, and the ranking of arguments follows the overloads still reachable. When the arguments do not decide, every overload that fits is shown.
- Calls of `abi.*` functions, of variables of function type and of `T.wrap` / `T.unwrap` are typed, so completion goes on after them.

## 0.5.0 — 2026-10-14

- Hover, on by default (`solidityWorkbench.hover.enabled`), without running solc:
  - built-in globals and members (`msg.sender`, `block.timestamp`, `abi.encode`, `keccak256`, `addr.balance`, `type(X).max`, units) with their type and documentation, following the file's solc version (not yet available, deprecated);
  - ranges and sizes of elementary types;
  - declarations of local variables, parameters, state variables, constants, functions, modifiers, events, errors, structs, enums and contracts, across imports and inheritance, with their NatSpec; parameters show their `@param` text;
  - inherited documentation: functions without NatSpec take it from the function they override, and `@inheritdoc` is followed;
  - overloads chosen by the number of arguments; `using ... for` members from solc's AST when it is already built.

## 0.4.0 — 2026-10-14

- Rename Symbol (`F2`), on by default (`solidityWorkbench.rename.enabled`):
  - local variables and parameters, instantly and on half-written code, respecting blocks and shadowing, with their `@param` / `@return` tags;
  - everything else across `src`, `test` and `script` from solc's AST: state variables and getter calls, functions with their whole override hierarchy (interfaces included), modifiers, events, errors, structs and fields (named arguments too), enums and values, user-defined value types, contracts, libraries, constants, free functions and import aliases;
  - a contract's file is renamed with it, with its import paths, when it declares nothing else;
  - refused, with the reason, for library symbols, code that does not compile, invalid names and renames that would change what other names refer to: every rename is checked by compiling the result.
- Find All References, from the tolerant parser for locals and solc's AST for the rest, including uses through import aliases and named arguments.
- Document Highlight.
- Go to Definition resolves local variables and members of values (`token.transfer`, `listing.price`), and anything else solc resolves.
- Projects mixing pragmas are compiled per solc version, like `forge build`; solc ASTs are parsed in a worker thread.

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
