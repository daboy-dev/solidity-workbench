import { parse as parseToml } from "smol-toml";
import { runForge, type Env, type ExecFn } from "../foundry/forge";

/** Compiler-related project settings, as `forge build` would apply them. */
export interface CompilerSettings {
  /** `solc` / `solc_version`: a version ("0.8.30") or a path to a solc binary. Undefined = auto-detect. */
  readonly solc?: string;
  readonly evmVersion?: string;
  /** solc error codes (as strings) that forge would not report. */
  readonly ignoredErrorCodes: ReadonlySet<string>;
  /** Path prefixes (relative to the root) whose warnings forge would not report. */
  readonly ignoredWarningsFrom: readonly string[];
  readonly origin: "forge config" | "foundry.toml";
}

/**
 * Names accepted by foundry in `ignored_error_codes`, with their solc codes.
 * Checked against solc 0.8.37 output; `transient-storage` (2394) comes from
 * foundry-compilers, recent solc versions no longer emit it.
 */
export const ERROR_CODE_NAMES: Readonly<Record<string, string>> = {
  license: "1878",
  "constructor-visibility": "2462",
  "code-size": "5574",
  "init-code-size": "3860",
  "func-mutability": "2018",
  "unused-var": "2072",
  "unused-param": "5667",
  "unused-return": "9302",
  "virtual-interfaces": "5815",
  "missing-receive-ether": "3628",
  shadowing: "2519",
  "same-varname": "8760",
  "unnamed-return": "6321",
  unreachable: "5740",
  "pragma-solidity": "3420",
  "transient-storage": "2394",
  "too-many-warnings": "4591",
  "transfer-deprecated": "9207",
  "natspec-memory-safe-assembly-deprecated": "2424",
};

/** forge's defaults for `ignored_error_codes` (forge 1.x). */
export const FORGE_DEFAULT_IGNORED = [
  "license",
  "code-size",
  "init-code-size",
  "transient-storage",
  "transfer-deprecated",
  "natspec-memory-safe-assembly-deprecated",
];

/** Normalizes names and numbers from `ignored_error_codes` (or our own setting) to solc codes. */
export function resolveErrorCodes(values: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const s = String(v).trim();
    if (/^\d+$/.test(s)) out.add(s);
    else if (ERROR_CODE_NAMES[s]) out.add(ERROR_CODE_NAMES[s]);
  }
  return out;
}

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

function fromValues(v: Table, origin: CompilerSettings["origin"]): CompilerSettings {
  const solc = typeof v["solc"] === "string" ? v["solc"] : typeof v["solc_version"] === "string" ? v["solc_version"] : undefined;
  const evm = typeof v["evm_version"] === "string" ? v["evm_version"] : undefined;
  const ignored = Array.isArray(v["ignored_error_codes"]) ? v["ignored_error_codes"] : FORGE_DEFAULT_IGNORED;
  const from = Array.isArray(v["ignored_warnings_from"]) ? v["ignored_warnings_from"].filter((x): x is string => typeof x === "string") : [];
  return {
    ...(solc ? { solc } : {}),
    ...(evm ? { evmVersion: evm.toLowerCase() } : {}),
    ignoredErrorCodes: resolveErrorCodes(ignored),
    ignoredWarningsFrom: from.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
    origin,
  };
}

/** Reads compiler settings from foundry.toml (default profile overlaid with `profile`). */
export function compilerSettingsFromToml(text: string, profile = "default"): CompilerSettings {
  let doc: Table = {};
  try {
    doc = parseToml(text) as Table;
  } catch {
    // Invalid TOML: forge defaults.
  }
  const profiles = isTable(doc["profile"]) ? doc["profile"] : {};
  const merged: Table = Object.assign(
    {},
    isTable(doc["default"]) ? doc["default"] : {},
    isTable(profiles["default"]) ? profiles["default"] : {},
    profile !== "default" && isTable(profiles[profile]) ? profiles[profile] : {},
  );
  return fromValues(merged, "foundry.toml");
}

/** Resolved settings from `forge config --json` (profiles, env vars and defaults applied by forge). */
export async function compilerSettingsFromForge(root: string, options: { forgePath?: string; env?: Env; exec?: ExecFn } = {}): Promise<CompilerSettings> {
  const { stdout } = await runForge(["config", "--json"], root, options);
  const json = JSON.parse(stdout) as unknown;
  if (!isTable(json)) throw new Error("Unexpected `forge config --json` output");
  return fromValues(json, "forge config");
}
