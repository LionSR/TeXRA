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

import type { ExecutionId } from '@shared/schemas';

import type {
  LeanFileCommand,
  LeanProjectCommand,
  FetchDiagnosticsResult,
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
  fetchDiagnosticsForFile(file: string): Promise<FetchDiagnosticsResult>;
  /**
   * Move the host editor cursor to the first error in `diagnostics`, when the
   * host has an editor to move (VS Code). A host capability, not a query:
   * CLI/desktop adapters omit it, and `lean_diagnostics` skips it when absent,
   * rather than pretending navigation happened. The tool result always carries
   * the diagnostic list, so the model can act on it with or without this.
   */
  navigateToFirstError?(
    filePath: string,
    diagnostics: LeanDiagnostic[],
  ): Promise<void>;
  executeProjectCommand(command: LeanProjectCommand): Promise<void>;
  /**
   * Stop the per-worktree servers attributed to an agent run that ended.
   * A host capability like {@link navigateToFirstError}: the direct
   * CLI/desktop adapter implements it so a finished run does not leave its
   * worktree's server idling until the idle timeout; the VS Code bridge
   * omits it because the Lean 4 extension owns that server's lifetime.
   * Servers still leased by an in-flight request (e.g. a shared worktree's
   * other run) are left to the idle-timeout backstop.
   */
  stopSessionsForRun?(runId: ExecutionId): Promise<void>;
}

let services: LeanLanguageServices | undefined;

export function setLeanLanguageServices(s: LeanLanguageServices): void {
  services = s;
}

/**
 * Resolve the registered {@link LeanLanguageServices}, throwing when no host
 * wired one. The throw is intentional: a host that never called
 * {@link setLeanLanguageServices} (e.g. platform startup missed the wiring)
 * must fail at first use with a message that names the missing registration,
 * not with a silent or toolchain-only failure. Every caller wraps this error
 * into a tool-level result, so the guidance below reaches the user.
 */
export function getLeanLanguageServices(): LeanLanguageServices {
  if (!services) {
    throw new Error(
      'Lean language services not initialized: no host called setLeanLanguageServices() during platform startup. In VS Code this is wired by the extension host; in CLI/desktop by registerDirectLeanLanguageServices().',
    );
  }
  return services;
}

/**
 * Run-end hook for the agent run lifecycle: stop the Lean servers the ended
 * run started. A no-op when no host wired Lean services, or when the wired
 * host owns server lifetime itself (the VS Code bridge) — only the direct
 * CLI/desktop adapter implements {@link LeanLanguageServices.stopSessionsForRun}.
 */
export async function stopLeanServersForEndedRun(
  runId: ExecutionId,
): Promise<void> {
  await services?.stopSessionsForRun?.(runId);
}
