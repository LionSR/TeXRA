/**
 * Injectable language services for Lean tools.
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

import type {
  LeanFileCommand,
  LeanProjectCommand,
  LeanDiagnostic,
  LspHover,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from './leanTypes';

export interface LeanLanguageServices {
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
  ): Promise<LspResult<LspHover>>;
  fetchDiagnosticsForFile(file: string): Promise<LeanDiagnostic[] | null>;
  navigateToFirstError(
    filePath: string,
    diagnostics: LeanDiagnostic[],
  ): Promise<void>;
  executeProjectCommand(command: LeanProjectCommand): Promise<void>;
}

let services: LeanLanguageServices | undefined;

export function setLeanLanguageServices(s: LeanLanguageServices): void {
  services = s;
}

export function getLeanLanguageServices(): LeanLanguageServices {
  if (!services) {
    throw new Error('Lean language services not initialized');
  }
  return services;
}
