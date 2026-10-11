import * as vscode from "vscode";
import type { WorkbenchCore } from "../host/workbenchCore";
import { isFeatureEnabled, SECTION } from "../host/settings";
import type { Feature } from "./feature";

/** Activates and deactivates features as their `enabled` setting changes. */
export class FeatureRegistry implements vscode.Disposable {
  private readonly active = new Map<string, vscode.Disposable>();
  private readonly listener: vscode.Disposable;

  constructor(
    private readonly core: WorkbenchCore,
    private readonly features: readonly Feature[],
  ) {
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (this.features.some((f) => e.affectsConfiguration(`${SECTION}.${f.id}.enabled`))) this.sync();
    });
    this.sync();
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  private sync(): void {
    for (const feature of this.features) {
      const enabled = isFeatureEnabled(feature.id);
      const current = this.active.get(feature.id);
      if (enabled && !current) {
        try {
          this.active.set(feature.id, feature.activate(this.core));
          this.core.log.info(`Feature enabled: ${feature.id}`);
        } catch (err) {
          this.core.log.error(`Could not enable feature ${feature.id}`, err);
        }
      } else if (!enabled && current) {
        current.dispose();
        this.active.delete(feature.id);
        this.core.log.info(`Feature disabled: ${feature.id}`);
      }
    }
  }

  dispose(): void {
    this.listener.dispose();
    for (const d of this.active.values()) d.dispose();
    this.active.clear();
  }
}
