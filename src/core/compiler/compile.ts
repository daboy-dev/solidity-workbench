import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runProcess } from "../process";
import type { ProjectModel } from "../project/projectModel";
import { formatRemapping } from "../project/remappings";
import { computeLineStarts, lineOf } from "../solidity/extractSymbols";
import { analyzeFile } from "../solidity/fileAnalysis";
import { damerauLevenshtein } from "../solidity/syntaxCheck";
import { chooseSolc, pragmaRanges, type InstalledSolc, type SolcChoice } from "./solcVersions";

export type Severity = "error" | "warning" | "info";

export interface CompilerDiagnostic {
  /** UTF-16 offsets in the file's text. */
  readonly start: number;
  readonly end: number;
  readonly severity: Severity;
  readonly code: string;
  /** solc's error type, e.g. TypeError, DeclarationError, ParserError. */
  readonly type: string;
  readonly message: string;
  readonly related: ReadonlyArray<{ readonly file: string; readonly start: number; readonly end: number; readonly message: string }>;
}

export interface CompileResult {
  readonly solc: InstalledSolc;
  readonly reason: string;
  /** Diagnostics per absolute path, for every non-library file that was part of the compilation (possibly empty). */
  readonly diagnostics: Map<string, CompilerDiagnostic[]>;
  /** Texts of the files that diagnostics refer to, as compiled (offsets are relative to these). */
  readonly texts: Map<string, string>;
  readonly durationMs: number;
}

export type CompileOutcome = { readonly kind: "compiled"; readonly result: CompileResult } | { readonly kind: "noSolc"; readonly requirement: string };

export type SolcExec = (solc: string, args: readonly string[], cwd: string, input: string, signal?: AbortSignal) => Promise<string>;

export interface CompileRequest {
  readonly project: ProjectModel;
  /** Absolute path of the file to analyse. */
  readonly entry: string;
  /** Unsaved contents by absolute path; must include the entry. */
  readonly overlays: ReadonlyMap<string, string>;
  readonly installed: readonly InstalledSolc[];
  /** Overrides the solc of the project configuration (a version or a path). */
  readonly solcOverride?: string;
  /** Extra solc error codes to hide (from the user's setting). */
  readonly extraIgnoredCodes?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  readonly exec?: SolcExec;
}

const defaultSolcExec: SolcExec = (solc, args, cwd, input, signal) =>
  runProcess(solc, args, { cwd, input, timeoutMs: 60_000, ...(signal ? { signal } : {}) });

export interface SolcError {
  severity: Severity;
  errorCode?: string;
  type: string;
  message: string;
  sourceLocation?: { file: string; start: number; end: number };
  secondarySourceLocations?: Array<{ file?: string; start?: number; end?: number; message?: string }>;
}

export interface SolcOutput {
  errors?: SolcError[];
  sources?: Record<string, unknown>;
}

/**
 * Analyses `entry` with solc, including unsaved changes, and returns the
 * diagnostics `forge build` would show for the project's own files.
 * Throws an AbortError when `signal` fires.
 */
export async function compile(req: CompileRequest): Promise<CompileOutcome> {
  const started = Date.now();
  const configured = req.solcOverride || req.project.compiler.solc;
  const entryText = req.overlays.get(req.entry) ?? (await fs.readFile(req.entry, "utf8"));
  let ranges = pragmaRanges(entryText);
  let choice = chooseSolc(req.installed, ranges, configured);
  if (choice.kind === "missing") return { kind: "noSolc", requirement: choice.requirement };

  let output = await run(req, choice.solc, true);
  // An imported file may require another version than the entry (error 5333): retry once with
  // every pragma involved, unless the version is pinned by the configuration.
  const versionErrors = (output.errors ?? []).filter((e) => e.errorCode === "5333" && e.sourceLocation);
  if (versionErrors.length && !configured) {
    for (const e of versionErrors) ranges = [...ranges, ...pragmaRanges(await readSource(req, e.sourceLocation!.file))];
    const retry: SolcChoice = chooseSolc(req.installed, ranges, undefined);
    if (retry.kind === "found" && retry.solc.version !== choice.solc.version) {
      choice = retry;
      output = await run(req, choice.solc, true);
    }
  }

  const texts = new Map<string, string>();
  const errors = output.errors ?? [];
  for (const name of new Set([...Object.keys(output.sources ?? {}), ...errors.flatMap((e) => locationsOf(e).map((l) => l.file))])) {
    const abs = req.project.absolutePath(name);
    texts.set(abs, await readSource(req, name));
  }
  texts.set(req.entry, entryText);
  const diagnostics = toDiagnostics(req, errors, Object.keys(output.sources ?? {}), texts);
  return { kind: "compiled", result: { solc: choice.solc, reason: choice.reason, diagnostics, texts, durationMs: Date.now() - started } };
}

async function run(req: CompileRequest, solc: InstalledSolc, withEvmVersion: boolean): Promise<SolcOutput> {
  const { project } = req;
  const sources: Record<string, { content: string }> = {};
  for (const [abs, content] of req.overlays) {
    if (project.contains(abs) && project.areaOf(abs) !== "lib") sources[project.sourceUnitName(abs)] = { content };
  }
  // Analysis only: no bytecode, ABI or AST is requested, which keeps solc fast.
  return runStandardJson({ project, solc, sources, outputSelection: { "*": { "": [] } }, withEvmVersion, ...pick(req) });
}

const pick = (req: CompileRequest) => ({ ...(req.signal ? { signal: req.signal } : {}), ...(req.exec ? { exec: req.exec } : {}) });

export interface StandardJsonRequest {
  readonly project: ProjectModel;
  readonly solc: InstalledSolc;
  /** Sources by source unit name; imports of other files are read by solc from disk. */
  readonly sources: Readonly<Record<string, { readonly content: string }>>;
  readonly outputSelection: unknown;
  readonly withEvmVersion?: boolean;
  readonly signal?: AbortSignal;
  readonly exec?: SolcExec;
}

/** Runs solc's standard JSON interface with the project's remappings and EVM version. */
export async function runStandardJson(req: StandardJsonRequest): Promise<SolcOutput> {
  const { project, solc } = req;
  const evmVersion = req.withEvmVersion !== false ? project.compiler.evmVersion : undefined;
  const input = {
    language: "Solidity",
    sources: req.sources,
    settings: {
      remappings: project.remappings.map(formatRemapping),
      outputSelection: req.outputSelection,
      ...(evmVersion ? { evmVersion } : {}),
    },
  };
  const args = ["--standard-json", "--base-path", project.root, "--allow-paths", project.root];
  const stdout = await (req.exec ?? defaultSolcExec)(solc.path, args, project.root, JSON.stringify(input), req.signal);
  const output = JSON.parse(stdout) as SolcOutput;
  // Older solc versions reject newer EVM versions (forge downgrades them): retry with the default.
  if (evmVersion && output.errors?.some((e) => e.severity === "error" && /evm ?version/i.test(e.message) && !e.sourceLocation)) {
    return runStandardJson({ ...req, withEvmVersion: false });
  }
  return output;
}

async function readSource(req: CompileRequest, sourceUnitName: string): Promise<string> {
  const abs = req.project.absolutePath(sourceUnitName);
  const overlay = req.overlays.get(abs);
  if (overlay !== undefined) return overlay;
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return "";
  }
}

function locationsOf(e: SolcError): Array<{ file: string }> {
  const out: Array<{ file: string }> = [];
  if (e.sourceLocation?.file) out.push({ file: e.sourceLocation.file });
  for (const s of e.secondarySourceLocations ?? []) if (s.file) out.push({ file: s.file });
  return out;
}

/**
 * Turns solc errors into diagnostics per file, the way `forge build` reports them:
 * - codes in `ignored_error_codes` (and the user's setting) are hidden, except errors;
 * - warnings from `ignored_warnings_from` and from library files are hidden;
 * - errors located in libraries (or nowhere) are shown on the entry file, so they are not missed.
 */
function toDiagnostics(req: CompileRequest, errors: readonly SolcError[], compiled: readonly string[], texts: Map<string, string>): Map<string, CompilerDiagnostic[]> {
  const { project } = req;
  const out = new Map<string, CompilerDiagnostic[]>();
  for (const name of compiled) {
    const abs = project.absolutePath(name);
    if (project.areaOf(abs) !== "lib") out.set(abs, []);
  }
  out.set(req.entry, out.get(req.entry) ?? []);

  const ignored = new Set([...project.compiler.ignoredErrorCodes, ...(req.extraIgnoredCodes ?? [])]);
  const converters = new Map<string, (byte: number) => number>();
  const toUtf16 = (abs: string) => {
    let c = converters.get(abs);
    if (!c) {
      c = byteToUtf16Converter(texts.get(abs) ?? "");
      converters.set(abs, c);
    }
    return c;
  };

  for (const e of errors) {
    const code = e.errorCode ?? "";
    if (e.severity !== "error" && ignored.has(code)) continue;
    const loc = e.sourceLocation;
    const abs = loc?.file ? project.absolutePath(loc.file) : undefined;
    if (e.severity !== "error" && loc?.file && project.compiler.ignoredWarningsFrom.some((p) => loc.file.startsWith(p))) continue;

    const related = (e.secondarySourceLocations ?? [])
      .filter((s) => s.file && s.start !== undefined && s.start >= 0)
      .map((s) => {
        const file = project.absolutePath(s.file!);
        const conv = toUtf16(file);
        return { file, start: conv(s.start!), end: conv(Math.max(s.start!, s.end ?? s.start!)), message: s.message ?? "" };
      });

    if (abs && loc && loc.start >= 0 && project.areaOf(abs) !== "lib") {
      const conv = toUtf16(abs);
      const text = texts.get(abs) ?? "";
      const [start, end] = narrowRange(text, conv(loc.start), conv(Math.max(loc.start, loc.end)));
      const list = out.get(abs) ?? [];
      list.push({ start, end, severity: e.severity, code, type: e.type, message: enrichMessage(code, e.message, text.slice(start, end)), related });
      out.set(abs, list);
      continue;
    }
    // Library or file-less diagnostics: only errors matter, shown at the entry's first import (or top).
    if (e.severity !== "error") continue;
    const where = abs && loc && loc.start >= 0 ? `${loc.file}:${positionLabel(texts.get(abs) ?? "", toUtf16(abs)(loc.start))}: ` : "";
    const anchor = firstImport(texts.get(req.entry) ?? "");
    out.get(req.entry)!.push({ ...anchor, severity: "error", code, type: e.type, message: `${where}${e.message}`, related });
  }
  return out;
}

const DECLARATION = /^(?:abstract\s+contract|contract|interface|library|function|modifier|constructor|fallback|receive|struct|enum)\b/;

/**
 * solc often locates an error on a whole declaration (e.g. 3415 on the entire
 * contract). Underlining a whole contract is unreadable, so such ranges are
 * reduced to the declaration header (before `{`), and any other multi-line
 * range to its first line.
 */
export function narrowRange(text: string, start: number, end: number): [number, number] {
  const slice = text.slice(start, end);
  let cut = slice.length;
  if (DECLARATION.test(slice)) {
    const brace = slice.indexOf("{");
    if (brace > 0) cut = brace;
  }
  const newline = slice.indexOf("\n");
  if (newline >= 0 && newline < cut) cut = newline;
  let e = start + cut;
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  return [start, e > start ? e : end];
}

/** Converts solc's UTF-8 byte offsets to the UTF-16 offsets used by editors. */
export function byteToUtf16Converter(text: string): (byte: number) => number {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length === text.length) return (byte) => Math.min(byte, text.length); // ASCII only.
  return (byte) => buffer.subarray(0, Math.min(byte, buffer.length)).toString("utf8").length;
}

function positionLabel(text: string, offset: number): string {
  const starts = computeLineStarts(text);
  const line = lineOf(starts, offset);
  return `${line + 1}:${offset - starts[line]! + 1}`;
}

function firstImport(text: string): { start: number; end: number } {
  const imp = analyzeFile(text).imports[0];
  return imp ? { start: imp.start, end: imp.end } : { start: 0, end: 0 };
}

const LIKELY_KEYWORDS = [
  "returns", "return", "memory", "storage", "calldata", "external", "public", "internal", "private", "view", "pure",
  "payable", "override", "virtual", "constant", "immutable", "emit", "revert", "require", "mapping", "address",
  "uint256", "bool", "string", "bytes", "indexed", "anonymous", "unchecked", "modifier",
];

/** Adds "Did you mean `returns`?" to unknown-identifier errors that look like a misspelled keyword. */
export function enrichMessage(code: string, message: string, identifier: string): string {
  if ((code !== "7576" && code !== "7920") || !/^[A-Za-z_$][\w$]*$/.test(identifier) || /Did you mean/.test(message)) return message;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of LIKELY_KEYWORDS) {
    const d = damerauLevenshtein(identifier.toLowerCase(), k);
    if (d > 0 && d <= (k.length <= 5 ? 1 : 2) && d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best ? `${message} Did you mean \`${best}\`?` : message;
}

export const solcLabel = (s: InstalledSolc) => (s.version === "custom" ? path.basename(s.path) : `solc ${s.version}`);
