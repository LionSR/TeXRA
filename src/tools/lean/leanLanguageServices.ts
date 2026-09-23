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

import { Context, Layer, type Effect } from 'effect';

import type { RunId } from '@shared/schemas';

import type { LeanServerInfo } from './leanServerRegistry';
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
 * is composed directly by the native tool dispatcher. Run ownership is passed
 * explicitly at invocation; adapters never recover it from ambient state. The adapters' failure
 * channels are disjoint (the VS Code bridge fails with its editor, command
 * and extension tags, the direct pool with its own) and every consumer folds
 * a failure into a `ToolError`, so the port declares `unknown` rather than a
 * union no caller switches on.
 *
 * Every file parameter is an absolute path: the calling tool resolves the
 * model's input against the run's working directory (`leanFilePath` in
 * `LspTools.ts`) before invoking the port, so an adapter never re-resolves.
 */
export interface LeanLanguageServicesShape {
  /**
   * The servers this adapter currently holds, for the Tools dashboard. The
   * adapter owns the roster (`createLeanServerRoster`): the VS Code bridge
   * records one virtual entry per Lean 4 client it reaches, the direct pool
   * one per `lake env lean --server` it spawns, and both tables die with the
   * process runtime that built the adapter. Synchronous because both are a
   * read of an in-memory map.
   */
  listServers(): readonly LeanServerInfo[];
  executeFileCommand(
    command: LeanFileCommand,
    filePath: string,
    runId?: RunId,
  ): Effect.Effect<boolean>;
  getGoalState(
    filePath: string,
    line: number,
    column: number,
    runId?: RunId,
  ): Effect.Effect<LspResult<PlainGoal>>;
  getTermGoal(
    filePath: string,
    line: number,
    column: number,
    runId?: RunId,
  ): Effect.Effect<LspResult<PlainTermGoal>>;
  getHoverInfo(
    filePath: string,
    line: number,
    column: number,
    runId?: RunId,
  ): Effect.Effect<LspResult<LspHover>>;
  fetchDiagnosticsForFile(
    file: string,
    runId?: RunId,
  ): Effect.Effect<FetchDiagnosticsResult>;
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
  ): Effect.Effect<void>;
  executeProjectCommand(
    command: LeanProjectCommand,
    runId?: RunId,
  ): Effect.Effect<void, Error>;
  /**
   * Stop the per-worktree servers attributed to an agent run that ended.
   * A host capability like {@link navigateToFirstError}: the direct
   * CLI/desktop adapter implements it so a finished run does not leave its
   * worktree's server idling until the idle timeout; the VS Code bridge
   * omits it because the Lean 4 extension owns that server's lifetime.
   * Servers still leased by an in-flight request (e.g. a shared worktree's
   * other run) are marked for disposal when their final lease ends.
   */
  stopSessionsForRun?(runId: RunId): Effect.Effect<void>;
}

/**
 * The process-lifetime Lean port, provided once by each composition root
 * through `installProcessRuntime`'s `lean` option: the VS Code extension
 * over its Lean 4 extension bridge, the Node hosts (CLI, desktop, the agent
 * package) over the direct `lake env lean --server` pool. A tool or run
 * program reads it with `yield* LeanLanguageServices`; a host that never
 * provided one fails to type check, not at first use.
 */
export class LeanLanguageServices extends Context.Service<
  LeanLanguageServices,
  LeanLanguageServicesShape
>()('@texra/tools/LeanLanguageServices') {
  /** The port over an already-built adapter (the VS Code bridge). */
  static layer(
    services: LeanLanguageServicesShape,
  ): Layer.Layer<LeanLanguageServices> {
    return Layer.succeed(LeanLanguageServices)(services);
  }
}
