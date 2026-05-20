/**
 * Injectable VS Code services for Lean tools.
 *
 * Provides a seam between the platform-agnostic tool implementations
 * in `src/tools/lean/` and the host-specific integrations (VS Code
 * extension in `packages/extension/src/frontend/lean/`, direct LSP for
 * CLI / desktop in `src/tools/lean/direct/`).
 *
 * The interface speaks in abstract command names; each adapter owns the
 * mapping to its native primitives (VS Code command IDs vs `lake` /
 * LSP requests).
 */

import type { Hover } from 'vscode-languageserver-protocol';

import type { LeanFileCommand, LeanProjectCommand } from './leanConstants';
import type {
  LeanDiagnostic,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from './leanTypes';

export interface LeanVscodeServices {
  executeFileCommand(
    command: LeanFileCommand,
    filePath: string,
  ): Promise<boolean>;
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
  executeProjectCommand(command: LeanProjectCommand): Promise<void>;
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
