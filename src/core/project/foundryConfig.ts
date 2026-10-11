import { parse as parseToml } from "smol-toml";
import { parseRemapping, type Remapping } from "./remappings";

/** The subset of foundry.toml the workbench cares about. Paths are relative to the project root. */
export interface FoundryConfig {
  readonly src: string;
  readonly test: string;
  readonly script: string;
  readonly libs: readonly string[];
  readonly remappings: readonly Remapping[];
}

export const DEFAULT_FOUNDRY_CONFIG: FoundryConfig = {
  src: "src",
  test: "test",
  script: "script",
  libs: ["lib"],
  remappings: [],
};

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

/**
 * Parses foundry.toml. Reads `[profile.default]` overlaid with the active
 * profile (`FOUNDRY_PROFILE`), and the legacy top-level `[default]` table.
 * Never throws: an unparsable file yields the defaults.
 */
export function parseFoundryConfig(text: string, profile = "default"): FoundryConfig {
  let doc: Table;
  try {
    doc = parseToml(text) as Table;
  } catch {
    return DEFAULT_FOUNDRY_CONFIG;
  }
  const tables: Table[] = [];
  if (isTable(doc["default"])) tables.push(doc["default"]);
  const profiles = isTable(doc["profile"]) ? doc["profile"] : {};
  if (isTable(profiles["default"])) tables.push(profiles["default"]);
  if (profile !== "default" && isTable(profiles[profile])) tables.push(profiles[profile]);

  const merged: Table = Object.assign({}, ...tables);
  const str = (key: string, fallback: string): string => {
    const v = merged[key];
    return typeof v === "string" && v.trim() ? cleanDir(v) : fallback;
  };
  const strList = (key: string): string[] | undefined => {
    const v = merged[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  };

  const remappings: Remapping[] = [];
  for (const line of strList("remappings") ?? []) {
    const r = parseRemapping(line);
    if (r) remappings.push(r);
  }

  return {
    src: str("src", DEFAULT_FOUNDRY_CONFIG.src),
    test: str("test", DEFAULT_FOUNDRY_CONFIG.test),
    script: str("script", DEFAULT_FOUNDRY_CONFIG.script),
    libs: (strList("libs") ?? [...DEFAULT_FOUNDRY_CONFIG.libs]).map(cleanDir),
    remappings,
  };
}
