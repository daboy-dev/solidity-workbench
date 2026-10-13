import semver from "semver";
import { chooseSolc, type InstalledSolc } from "../compiler/solcVersions";

/** Oldest version completion knows about; older pragmas get the 0.8.0 language. */
export const BASELINE_VERSION = "0.8.0";

/** Every 0.8 release completion may have to reason about, to resolve pragmas without an installed solc. */
const KNOWN_VERSIONS = Array.from({ length: 100 }, (_, i) => `0.8.${i}`);

/**
 * The solc version a file is written for, as chosen for compiler diagnostics:
 * the configured version, else the newest installed solc satisfying every
 * pragma, else the newest release satisfying them. A configured binary path
 * says nothing about its version, so the pragmas decide then.
 */
export function languageVersion(installed: readonly InstalledSolc[], ranges: readonly string[], configured: string | undefined): string {
  const isPath = configured !== undefined && /[\\/]/.test(configured);
  if (configured && !isPath) {
    const pinned = semver.valid(semver.coerce(configured));
    if (pinned) return atLeastBaseline(pinned);
  }
  if (!isPath) {
    const choice = chooseSolc(installed, ranges, undefined);
    if (choice.kind === "found" && semver.valid(choice.solc.version)) return atLeastBaseline(choice.solc.version);
  }
  const fitting = KNOWN_VERSIONS.filter((v) => ranges.every((r) => semver.satisfies(v, r)));
  if (ranges.length === 0) return KNOWN_VERSIONS.at(-1)!;
  // No 0.8 release fits: an older pragma.
  return fitting.at(-1) ?? BASELINE_VERSION;
}

function atLeastBaseline(version: string): string {
  return semver.lt(version, BASELINE_VERSION) ? BASELINE_VERSION : version;
}
