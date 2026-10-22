# Features

Every feature has its own `solidityWorkbench.<feature>.enabled` setting (see the [settings table](../README.md#settings)).

## Language completion

Suggestions for the code you are writing, also when it is half-written (unclosed blocks, missing semicolons, trailing commas):

- **Types and keywords for the context**: `address`, `bool`, `string`, `bytes`, `bytes1`…`bytes32`, `uint8`…`uint256`, `int8`…`int256`, `mapping` (as a snippet); `memory` / `storage` / `calldata` after reference types; `public`, `constant`, `immutable`, `transient`… after the type of a state variable; visibility, mutability, `virtual`, `override`, `returns` and the modifiers in scope in function headers, never repeating or contradicting what is already written; `indexed` in events; statement keywords (`if`, `for`, `emit`, `revert`, `unchecked`…) only inside bodies; units (`ether`, `days`…) after a number.
- **Values in scope**: parameters, local variables (respecting block scoping), state variables, constants and functions of the contract and of the contracts it inherits from, in any file (private members of bases excluded), and names declared or imported at file level. Events are suggested after `emit`, errors after `revert`, along with the contracts, interfaces and unit aliases that declare others (`emit Market.Listed(...)`, `revert IERC721Errors.ERC721NonexistentToken(...)`); after `emit Market.` only its events are listed, after `revert Market.` only its errors, and auto-import offers only events or errors there.
- **Named arguments**: inside `Order({ ... })`, left of `:` only the fields still missing are suggested (inserted as `field: `); right of `:`, values of a compatible type come first, and a matching name before everything else (`amount` or `amount_` for the field `amount`). Also for functions, events and errors called with `{...}`.
- **Expected types**: in `x = |`, `a == |`, `return |`, call arguments and initializers, values of the expected type come first, along with `msg.sender`, `block.timestamp` and similar when they fit. For an overloaded function, the type comes from the overloads the arguments already written can reach.
- **Members after `.`**: `msg`, `block`, `tx`, `abi`, `type(X)` (according to what X is), address members (`transfer` and `send` only on `address payable`), arrays, `bytes.concat` / `string.concat`; struct fields (`order.amount`, `orders[id].buyer`, `getOrder(id).buyer`); the external functions and public getters of contract-typed values (`token.balanceOf`, `IERC20(addr).transfer`), inherited ones included; `this.`, `super.`, library, enum and user-defined value type members, `selector` of errors and events (`Market.PriceZero.selector`, for `vm.expectRevert`), and unit aliases (`import "x.sol" as X`).
- **Functions attached with `using ... for`** after a value, shown without the first parameter (the value itself): `token.safeTransfer` with `using SafeERC20 for IERC20;`, `amount.mulDiv` with `using Math for uint256;`, `using {f, L.g} for T` and `global` directives of the file declaring the type. As solc does, only directives of the file and of the enclosing contract (not of its bases) apply, and only functions whose first parameter takes the value are listed; functions bound to an operator (`using {add as +}`) are not members. Calls are typed through them, so `a.mulDiv(b, c).` goes on.
- **Follows the solc version** chosen for the file (the same as compiler diagnostics, or the `pragma` when no solc is installed): `block.prevrandao` from 0.8.18, `block.blobbasefee` and `blobhash` from 0.8.24, `transient` from 0.8.28, and `transfer` / `send` shown as deprecated from 0.8.31.

```solidity
struct Order {
    address buyer;
    uint256 amount;
    uint256 deadline;
}

function placeOrder(uint256 amount, uint256 deadline) external {
    Order memory order = Order({
        buyer: msg.sender,
        |               // left of `:`: the missing fields, amount and deadline
    });
}
```

Right of `:` (`amount: |`), the parameter `amount` comes first: same name and same type.

Typing `add` puts `address` first; suggestions in scope and from the language rank before auto-import ones (such as the `Address` library), and a name already in scope is never offered for import.

## Auto-import in completions

Start typing the name of any contract, interface, library, struct, enum, error, event, user-defined value type, free function or file-level constant of the project or its dependencies, accept the suggestion, and the import is added:

```solidity
contract Vault is Ownab|
//               Ownable   @openzeppelin/contracts/access/Ownable.sol
```


- Suggests top-level symbols that are not yet in scope, with the import path shown next to the name.
- Also errors, events, structs and enums declared inside contracts, interfaces and libraries, inserted qualified with their container imported: `ERC721NonexistentToken` → `IERC721Errors.ERC721NonexistentToken` and `import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";`, ready for `vm.expectRevert(IERC721Errors.ERC721NonexistentToken.selector)`. When the container is already in scope, only the qualification is inserted; members already in scope (inherited ones, for example) are not offered.
- Adds a named import (`import {X} from "...";`) after the pragma and the last existing import.
- If the file already imports something from the same file, the new name is merged into it: `import {A, Ownable} from "...";`. Multi-line import lists, quote style and line endings are kept as they are.
- No suggestions inside comments or strings, nor for names already declared or imported in the file.
- When the same name exists in several files (e.g. nested copies in `lib/x/lib/y`), each distinct file gets its own suggestion. The ranking is:
  1. your own files, and files reached through a declared remapping (e.g. `@openzeppelin/contracts/`);
  2. files reached through an inferred remapping (`name/=lib/name/src/`);
  3. files only reachable through a relative path;
  4. within each tier, the least nested copy first.
- From files in `src/`, symbols defined in `test/` and `script/` are not suggested. From `test/` and `script/`, everything is.

## Import quick fix

On an *undeclared identifier* diagnostic (solc errors 7576 and 7920, from the built-in compiler diagnostics or from another extension), the light bulb offers `Import X from "..."` for each matching file. For an error, event, struct or enum declared in a contract, it offers `Import IERC721Errors from "..." and use IERC721Errors.ERC721NonexistentToken`, which also qualifies the name.

## Add Solidity Import command

`Solidity Workbench: Add Solidity Import` opens a searchable list of every indexed symbol, prefilled with the word under the cursor. It also accepts arguments, for keybindings:

```json
{
  "key": "ctrl+alt+i",
  "command": "solidityWorkbench.addImport",
  "args": { "name": "Ownable" }
}
```

## Syntax diagnostics

Syntax errors are reported as you type, without saving, with messages meant for people:

- `contact Vault {}` → *Unknown keyword `contact`. Did you mean `contract`?*, with a quick fix. Also inside bodies, for `revert` and `emit`: `revertr Unauthorized();` → *Did you mean `revert`?*, and for `using`: `uisng SafeERC20 for IERC20;` → *Did you mean `using`?*. Misspelled keywords are only reported where the code could never be valid, so a type named `Contact` is never flagged.
- A forgotten `}` in the middle of a file → *Missing `}` to close `function deposit` (opened on line 12)*. Indentation is used to find the block that was really left open, not just the last one.
- Trailing commas in argument and parameter lists, struct literals, enums and imports → *Trailing comma before `}` is not allowed*, with a quick fix to remove it. Empty tuple components such as `(bool ok, ) = ...` are valid and not reported.
- Extra or mismatched brackets, and the first parser error (*Missing `;`*, *Unexpected `)`*...). Errors that only follow from an earlier one are not repeated.

Analysis runs in a background thread. Type errors, unknown names and other semantic checks come from the compiler (below).

## Compiler diagnostics

While you type, the file is checked with **solc**, unsaved changes included, a moment after you stop typing (`solidityWorkbench.compilerDiagnostics.delay`, 400 ms). You see the same errors and warnings as with `forge build`: missing constructor arguments, type mismatches, undeclared identifiers, unused variables, shadowing...

- **solc version:** the `solc` of `foundry.toml` if set, else the newest installed version that satisfies the file's `pragma` (and those of its imports). The binaries installed by forge are used; the extension downloads nothing. If no installed version fits, you are offered to run `forge build` once, which installs it. The status bar shows the version in use.
- **Same filters as forge:** the project configuration comes from `forge config` (or `foundry.toml`), so `ignored_error_codes` (names or numbers, with forge's defaults) and `ignored_warnings_from` apply. Warnings from libraries are hidden. An error inside a library is shown on your file's first import, so it is not missed.
- **Readable ranges:** when solc points at a whole contract or function, only its header is underlined.
- Unknown identifiers that look like a misspelled keyword get a hint and a quick fix: `retruns` → *Did you mean `returns`?*.
- A missing data location (`Order order = ...`, `string s` in a parameter) gets quick fixes for the locations solc allows: `calldata` first for external function parameters, `memory` elsewhere.
- An address literal with an invalid checksum (often copied in lowercase from documentation) gets a quick fix that replaces it with the checksummed address solc suggests: `0x4752ba5dbc…` → `0x4752ba5DBc…`.
- These errors also drive the *Import X from ...* quick fix, without any other extension.
- Only analysis is requested from solc (no bytecode), so a check takes tens of milliseconds even with large dependencies. A new keystroke cancels the check in progress.

## Outline

The Outline view, breadcrumbs and *Go to Symbol in Editor* (`Ctrl+Shift+O` / `Cmd+Shift+O`) list contracts, interfaces and libraries with their functions, modifiers, events, errors, state variables, structs and enums, plus file-level declarations. The outline keeps working while the file has syntax errors.

## Hover

Hovering a name shows what it is, without running solc:

- **Built-ins**: type and documentation of `msg.sender`, `block.timestamp`, `tx.origin`, `abi.encode`, global functions (`keccak256`, `require`, `ecrecover`…), members of addresses, arrays, `bytes`/`string` and function pointers (`addr.balance`, `xs.length`, `f.selector`), `type(X)` members and units (`1 ether`, `2 days`). Like completion, it follows the file's solc version: `block.prevrandao` before 0.8.18 says it is not available yet, `block.difficulty` from 0.8.18 and `transfer`/`send` from 0.8.31 show their deprecation.
- **Elementary types**: the range of `uint8`…`int256` (`uint` is `uint256`), the size of `bytesN`, the members of `address` and `address payable`.
- **Project symbols**: the declaration of local variables, parameters, state variables (with their initializer for constants), functions, modifiers, events, errors, structs with their fields, enums with their values and contracts with their bases, followed by their NatSpec (`@notice`, `@dev`, `@param`, `@return`, `@title`, `@author`, `@custom:…`). A parameter shows its own `@param` line. Members of values (`token.transfer`, `listing.price`), inherited members, `super.` and imported names are resolved like Go to Definition; a member from another contract says where it is declared.
- **Inherited documentation**: as solc does, a function without NatSpec shows the documentation of the function it overrides, and `@inheritdoc Base` takes Base's documentation and adds the function's own tags.
- **Functions attached with `using ... for`** after a value (`token.safeTransfer`), resolved like completion does.
- **Overloads**: on a call, the overload its arguments reach, chosen like solc by number (or names) of arguments and implicit conversions (literals, derived contracts, functions passed as values); every overload that fits when the arguments do not decide (an argument the parser cannot type fits anything), and every overload when the name is not called. Base functions hidden by an override are not listed.

What the tolerant parser cannot resolve (members of expressions it cannot type) is taken from the project's solc AST when it is already built for the current text, for example after Find All References or a rename. Hover never starts solc. Unsaved changes are taken into account.

## Signature help

While you write a call, the parameters are shown with the one being filled highlighted, the NatSpec of the declaration and the `@param` text of each parameter (inherited documentation included, as in hover). It opens on `(` and `,`, and without running solc covers:

- functions of the file, of inherited contracts and of libraries, members of values (`token.transfer(`, `this.f(`, `super.f(`) and functions attached with `using ... for`, without the value they are called on (`token.safeTransfer(` shows `to` and `value`);
- events after `emit`, errors after `revert`, and struct constructors, positional (`Order(`) or with named arguments (`Order({amount: |})` highlights `amount`, and while writing a name, the first field not given yet);
- `new Vault(` (its constructor), `new bytes(` / `new string(` / `new uint256[](` (the length), `Price.wrap(` / `Price.unwrap(`;
- modifiers and base constructors in headers: `onlyRole(`, `constructor() Ownable(msg.sender)`, `contract Vault is ERC20("Vault", "V")`;
- variables of function type (`hasher(a, b)` for `function(bytes32, bytes32) view returns (bytes32) hasher`);
- built-in functions for the file's solc version: `require(`, `keccak256(`, `abi.encode(` (any number of arguments), `abi.decode(`, `string.concat(`, `addr.call(`...

Every overload is listed, and the one selected is the first the arguments written so far can reach, typed as for hover (the argument being written counts once it can be typed). Inside a conversion, parentheses or an index (`transfer(address(|`), the enclosing call is shown. Nothing is shown in comments, strings or parameter declarations.

## Navigation

- **Go to Definition** (`F12`, `Ctrl/Cmd+click`) on:
  - names declared in the file or imported, following aliases (`import {A as B}`), plain imports (`import "x.sol"`) and re-exports across files;
  - members of the current contract and of the contracts it inherits from, in any file (`onlyOwner`, `_msgSender`, inherited errors and events), with `super.` and `this.`;
  - qualified names: `Math.max` (every overload), `Errors.Unauthorized`, `Types.Side.Long`, `Alias.Symbol` for `import * as Alias`;
  - library functions attached with `using SafeERC20 for IERC20;`, `using {f} for T;` or `global` directives, e.g. `token.safeTransfer(...)`, without compiling;
  - local variables and parameters, respecting blocks and shadowing;
  - members of values, typed like completion does: `listing.price`, `token.transfer`, `IERC20(a).approve`, `listings[id].seller`, `Side.Long`;
  - overloads: the one the call's arguments reach, chosen like hover does; when the arguments do not decide, every overload that fits;
  - anything else solc resolves (members of expressions the tolerant analysis cannot type), from the project's AST when the tolerant analysis finds nothing.
- **Find All References** (`Shift+F12`, `Alt+Shift+F12`): every use of the symbol in `src`, `test` and `script`, with named arguments (`S({field: ...})`), NatSpec tags and the declarations it overrides or is overridden by (also in libraries, so the references of an OpenZeppelin function list your uses of it). On an import alias (`Y` in `import {X as Y}`), the uses of the alias. Local variables are found instantly with the tolerant parser; anything else uses solc's AST of the project (see [Rename Symbol](#rename-symbol)). If part of the project does not compile, the status bar says that the results may be incomplete.
- **Document Highlight**: the occurrences of the symbol under the cursor. Locals are exact; other symbols use the last AST of the project when the file has not changed since (solc is never started for this), and otherwise every occurrence of the same name in code.
- **Import paths are links**: `Ctrl/Cmd+click` on `"@openzeppelin/contracts/access/Ownable.sol"` opens the file, resolved with the project's remappings.
- **Go to Symbol in Workspace** (`Ctrl/Cmd+T`) searches the top-level symbols of every indexed project, dependencies included, and the errors, events, structs and enums of their contracts (shown with their container).

Unsaved changes in open files are taken into account.

## Rename Symbol

`F2` renames the symbol under the cursor; `Shift+Enter` in the rename box shows the preview first, with the edits grouped (the symbol, its overrides and implementations, import paths, file).

- **Local variables and parameters** (named returns, `for`, `try`/`catch` and tuple declarations included) are renamed instantly with the tolerant parser, also in half-written code, respecting blocks and shadowing. `@param` / `@return` tags of the function follow. Renaming a parameter also updates `f({name: ...})` calls in other files when the project compiles.
- **Everything else** is renamed across the project's own files (`src`, `test`, `script`) using solc's AST: state variables (and getter calls such as `vault.total()`), functions with every override and interface declaration in the hierarchy (other overloads are left alone), modifiers, events, errors, structs and their fields, enums and their values, user-defined value types, contracts, interfaces, libraries, file-level constants and free functions, including named arguments, `using ... for` calls, `emit`/`revert`, inline assembly references and NatSpec (`@param`, `@return`, `@inheritdoc`).
- **Import aliases**: renaming `X` updates `import {X as Y}` and leaves the uses of `Y`; renaming `Y` changes only its file.
- **Files**: renaming a contract in a file named after it (`Vault.sol`) that declares nothing else also renames the file and updates every import path pointing to it.

A rename is refused, with the reason, when:

- the new name is not a valid identifier, is a keyword, a type or a global name (`msg`, `this`…);
- the symbol is declared in `lib/`, or overrides a function declared there (library code is never edited);
- the project does not compile: the first error is shown. Files that do not compile and cannot use the symbol (they do not import its file, directly or not) are left out, so a broken test elsewhere does not block the rename;
- the result would not compile (e.g. the name is already declared), or any name would then refer to something else (e.g. a local variable named like the new name would capture it). Every rename is checked by compiling the renamed code before it is applied.

Strings and plain comments are never changed. Files with incompatible pragmas are compiled in groups, one per solc version, like `forge build`; a group needs its solc installed (run `forge build` once).

## Formatting (optional)

Formats with `forge fmt`, so the `[fmt]` section of your `foundry.toml` applies. It is **off by default**, since many people prefer to run `forge fmt` themselves. To use it, set `solidityWorkbench.formatting.enabled` to `true` and pick it as the formatter:

```json
"[solidity]": { "editor.defaultFormatter": "daboy-dev.solidity-workbench" }
```

If the file has a syntax error, nothing is changed and the reason is shown in the status bar. forge prints partially formatted code in that case, and that output is never applied.

## Other commands

- `Solidity Workbench: Rebuild Symbol Index`: discards the cache and re-indexes every project.
- `Solidity Workbench: Show Log`: indexing statistics and the remappings in use.

## Working alongside other Solidity extensions

Solidity Workbench does not register a grammar, and works with or without other Solidity extensions installed: it handles every `*.sol` file whatever its language id. Features that another extension also provides may conflict with it (for example, duplicated suggestions or diagnostics); every feature can be turned off with its `solidityWorkbench.<feature>.enabled` setting.

## Known limitations

- Auto-import offers top-level declarations, and errors, events, structs and enums of contracts. Functions, constants and state variables of contracts and libraries (`Math.mulDiv`) are completed after `Math.` once the library is imported.
- Language completion does not suggest Yul inside `assembly` blocks. Calls are typed by their declared return when it is a single value. Expressions with operators (`a + b`, `x ? a : b`) are not typed: as arguments they fit any overload, and nothing is suggested after `(a ? b : c).`.
- Overloads are resolved with implicit conversions between elementary types, literals and contract types; the value of a number literal is not checked (`f(300)` fits `uint8`), and function types are not compared parameter by parameter.
- NatSpec is shown as written: references such as `{IERC20-transfer}` are not turned into links. Yul inside `assembly` blocks has no hover and no signature help.
- Signature help of `new C(` shows the constructor declared in `C` only (none written: no parameters).
- The index reflects files on disk: symbols added to another file appear once it is saved.
- `import "x.sol";` puts every symbol of `x.sol` in scope and those are not suggested again. Symbols that `x.sol` itself imports, which solc also brings into scope, may still be suggested.
- Without forge, remappings are inferred with forge's main rules; unusual setups may differ. Install forge, or add a `remappings.txt`, for exact results.
- Projects without `foundry.toml` (e.g. Hardhat-only) are indexed with Foundry's default layout, so `contracts/` and `node_modules` are only covered when a remapping points at them.
- Compiler diagnostics need a solc installed by forge (svm) or set in `solidityWorkbench.compiler.solcPath`. `via_ir`, optimizer and other code generation settings are not applied, since only analysis runs.
- Go to Definition types members of values with the tolerant analysis: values of expressions it cannot type (e.g. functions returning several values) are resolved from solc's AST, which needs the project to compile. Inherited members are searched in declaration order, without solc's exact linearization for diamond hierarchies.
- Rename and Find All References of anything but local variables need the files involved to compile with an installed solc (a group of files whose solc is not installed blocks symbols it can use). Unit aliases (`import "x.sol" as X;` then `X.Name`) are renamed through `X.Name`, but the alias itself cannot be renamed. Yul identifiers declared inside `assembly` cannot be renamed, and renaming a local used in `assembly` to the name of a Yul builtin is not detected.
- Document Highlight of non-local symbols uses the AST of the last rename, reference search or definition from solc; until then it highlights every occurrence of the same name.
- Go to Symbol in Workspace lists top-level symbols and the errors, events, structs and enums of contracts, not their functions or variables.
- Syntax and compiler diagnostics may duplicate those of another Solidity extension. Turn off `solidityWorkbench.syntaxDiagnostics.enabled` / `solidityWorkbench.compilerDiagnostics.enabled`, or the equivalent in the other extension.
- Another Solidity extension with its own completions or auto-import may conflict with this one and show a similar suggestion next to ours. Disable the feature in one of them (`solidityWorkbench.completion.enabled`, `solidityWorkbench.autoImport.enabled`) if this is distracting.
- Without any Solidity extension, the workbench starts when the workspace contains a `.sol` file or a `foundry.toml`. A loose `.sol` file opened outside any workspace does not activate it.
- Deleting a folder other than a library may leave its symbols in the index until the next reload or `Rebuild Symbol Index`, depending on how the file watcher reports the deletion on your platform.
