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
import type { Effect } from 'effect';

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

/**
 * The Effect-typed port (Effect 4 runtime PRD, R1): adapters compose their
 * host or LSP primitives into these programs, and the one run of each program
 * sits in the calling tool's `execute()` — the tool execute() contract is an
 * R1 boundary kind, so no runtime leaks into this seam. The adapters' failure
 * channels are disjoint (VS Code bridge rejects with plain host errors, the
 * direct pool fails with its tagged errors) and every consumer folds a failure
 * into a `ToolError`, so the port declares `unknown` rather than a union no
 * caller switches on.
 */
export interface LeanLanguageServices {
  executeFileCommand(
    command: LeanFileCommand,
    filePath: string,
  ): Effect.Effect<boolean>;
  getGoalState(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<PlainGoal>>;
  getTermGoal(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<PlainTermGoal>>;
  getHoverInfo(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<LspHover>>;
  fetchDiagnosticsForFile(
    file: string,
  ): Effect.Effect<FetchDiagnosticsResult, unknown>;
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
  ): Effect.Effect<void, unknown>;
  executeProjectCommand(
    command: LeanProjectCommand,
  ): Effect.Effect<void, unknown>;
  /**
   * Stop the per-worktree servers attributed to an agent run that ended.
   * A host capability like {@link navigateToFirstError}: the direct
   * CLI/desktop adapter implements it so a finished run does not leave its
   * worktree's server idling until the idle timeout; the VS Code bridge
   * omits it because the Lean 4 extension owns that server's lifetime.
   * Servers still leased by an in-flight request (e.g. a shared worktree's
   * other run) are marked for disposal when their final lease ends.
   *
   * Stays Promise-typed until runtime lane D converts its only caller, the
   * `onRunEnd` hook of the agent run lifecycle (`executeAgent.ts`) — running
   * an Effect there today would put a below-boundary run in a lane-D file.
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
