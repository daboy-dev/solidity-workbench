# Contributing

```bash
npm install
npm run build            # esbuild bundle in dist/
npm run typecheck
npm run test:unit        # vitest, pure logic, no editor
npm run test:integration # @vscode/test-electron on test/fixtures/foundry-project
npm run package          # .vsix
```

Press F5 with *Run Extension (fixture project)* to open the fixture in an Extension Development Host.

Benchmarks on a large project (both use the real forge; the second also the installed solc):

- Indexing: `npm run build && node test/bench/indexBench.mjs <projectRoot> . <out.cjs>`.
- Language features: `npx esbuild test/bench/languageBench.ts --bundle --platform=node --outfile=<out.cjs> && node <out.cjs> <projectRoot>`.

Layout:

- `src/core/`: pure logic, with no `vscode` imports: the project model and remappings, forge and solc integration, the symbol index and its cache, document analysis (syntax, outline), navigation, language completion (tolerant structure parser, cursor context, scope and types, version-aware catalog of globals), import edits and candidate ranking.
- `src/host/`: the VS Code adapters of the core: settings, logging, project discovery, watchers.
- `src/features/<feature>/`: one folder per feature, each registering itself through the `FeatureRegistry`: `completion`, `autoImport`, `syntaxDiagnostics`, `compilerDiagnostics`, `outline`, `navigation`, `formatting`.
