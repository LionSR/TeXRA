/**
 * Injectable VS Code services for Lean tools.
 *
 * Provides a seam between the platform-agnostic tool implementations
 * in `src/tools/lean/` and the VS Code integration layer in `src/frontend/lean/`.
 * The services are registered during extension activation.
 */

import type { Hover } from 'vscode-languageserver-protocol';

import type {
  LeanDiagnostic,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from './leanTypes';

export interface LeanVscodeServices {
  getDiagnostics(filePath: string): LeanDiagnostic[];
  executeFileCommand(command: string, filePath: string): Promise<boolean>;
  getGoalState(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspResult<PlainGoal>>;
  getTermGoal(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspResult<PlainTermGoal>>;
  getHoverInfo(
    filePath: string,
    line: number,
    column: number,
  ): Promise<LspResult<Hover>>;
  fetchDiagnosticsForFile(file: string): Promise<LeanDiagnostic[] | null>;
  navigateToFirstError(
    filePath: string,
    diagnostics: LeanDiagnostic[],
  ): Promise<void>;
  executeGlobalCommand(commandId: string): Promise<void>;
  promptLean4ExtensionInstall(): Promise<void>;
}

let services: LeanVscodeServices | undefined;

export function setLeanVscodeServices(s: LeanVscodeServices): void {
  services = s;
}

export function getLeanVscodeServices(): LeanVscodeServices {
  if (!services) {
    throw new Error('Lean VS Code services not initialized');
  }
  return services;
}
