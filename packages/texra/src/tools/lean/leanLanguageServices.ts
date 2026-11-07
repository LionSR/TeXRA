/**
 * Injectable language services for Lean tools.
 *
 * Provides a boundary between the platform-agnostic tool implementations
 * in `packages/texra/src/tools/lean/` and the host-specific integrations (VS Code
 * extension in `packages/extension/src/frontend/lean/`, direct LSP for
 * CLI / desktop in `packages/texra/src/tools/lean/direct/`).
 *
 * The interface speaks in abstract command names; each adapter owns the
 * mapping to its native primitives (VS Code command IDs vs `lake` /
 * LSP requests).
 */

import { Context, type Effect, type Scope } from 'effect';

import type { LeanServerInfo } from './leanServerInfo';
import type {
  LeanFileCommand,
  LeanFileCommandFailed,
  LeanFileUnreadable,
  LeanProjectCommand,
  LeanUnavailable,
  FetchDiagnosticsResult,
  LspHover,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from './leanTypes';

/**
 * The Effect-typed port: adapters compose their
 * host or LSP primitives into these programs, and the one run of each program
 * is composed directly by the native tool dispatcher. The adapters' failure
 * channels are disjoint (the VS Code bridge fails with its editor, command
 * and extension tags, the direct pool with its own) and every consumer converts
 * a failure into a `ToolError`, so the port declares `Error` rather than a
 * union no caller switches on. The file calls, whose cause the tool reports,
 * fail with the tags in `./leanTypes` (`LeanUnavailable`, `LeanFileUnreadable`,
 * `LeanFileCommandFailed`), which each adapter maps to.
 *
 * Every call requires the `Scope` the resources it starts stay held in: the
 * calling tool provides its run's scope, so a server the direct pool starts
 * for a run stays up until the run ends; outside a run, the call's own.
 *
 * Every file parameter is an absolute path: the calling tool resolves the
 * model's input against the run's working directory (`leanFilePath` in
 * `LspTools.ts`) before invoking the port, so an adapter never re-resolves.
 */
export interface LeanLanguageServicesShape {
  /** The servers this adapter holds now, for the Tools dashboard. */
  readonly listServers: Effect.Effect<readonly LeanServerInfo[]>;
  executeFileCommand(
    command: LeanFileCommand,
    filePath: string,
  ): Effect.Effect<void, LeanFileCommandFailed | LeanUnavailable, Scope.Scope>;
  getGoalState(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<PlainGoal>, never, Scope.Scope>;
  getTermGoal(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<PlainTermGoal>, never, Scope.Scope>;
  getHoverInfo(
    filePath: string,
    line: number,
    column: number,
  ): Effect.Effect<LspResult<LspHover>, never, Scope.Scope>;
  fetchDiagnosticsForFile(
    file: string,
  ): Effect.Effect<
    FetchDiagnosticsResult,
    LeanUnavailable | LeanFileUnreadable,
    Scope.Scope
  >;
  executeProjectCommand(
    command: LeanProjectCommand,
  ): Effect.Effect<void, Error, Scope.Scope>;
}

/**
 * The Lean 4 plugin's port, its process layer (`lean4` in
 * `./plugin`): the direct `lake env lean --server` pool, or
 * the VS Code extension's Lean 4 bridge, which that host passes with TeXRA's
 * plugins (`texraPlugins`). A Lean tool reads it with
 * `yield* LeanLanguageServices`, served by the step that pinned the plugin;
 * the plugin's availability probe reads it while the layer is up.
 */
export class LeanLanguageServices extends Context.Service<
  LeanLanguageServices,
  LeanLanguageServicesShape
>()('@texra/tools/LeanLanguageServices') {}
