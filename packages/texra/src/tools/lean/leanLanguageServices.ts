/**
 * The Lean tools' language services: the `lake env lean --server` pool in
 * `./direct/leanServerPool`, served as the Lean 4 plugin's process layer.
 */

import { Context, type Effect, type Scope } from 'effect';

import type { LeanServerInfo } from './leanServerInfo';
import type {
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
 * The pool's operations, each run once by the native tool dispatcher. Every
 * caller converts a failure into a `ToolError`, so a call whose cause no tool
 * reports declares `Error`; the file calls, whose cause the tool reports, fail
 * with the tags in `./leanTypes` (`LeanUnavailable`, `LeanFileUnreadable`,
 * `LeanFileCommandFailed`).
 *
 * Every call requires the `Scope` the resources it starts stay held in: the
 * calling tool provides its run's scope, so a server the pool starts for a
 * run stays up until the run ends.
 *
 * Every file parameter is an absolute path: the calling tool resolves the
 * model's input against the run's working directory (`leanFilePath` in
 * `LspTools.ts`) before the call, so the pool never re-resolves.
 */
export interface LeanLanguageServicesShape {
  /** The servers the pool holds now, for the Tools dashboard. */
  readonly listServers: Effect.Effect<readonly LeanServerInfo[]>;
  /** Close the file at its server and open it again with fresh contents. */
  restartFile(
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
 * The Lean 4 plugin's process layer (`lean4` in `./plugin`). A Lean tool
 * reads it with `yield* LeanLanguageServices`, served by the step that
 * pinned the plugin; the plugin's availability probe reads it while the
 * layer is up.
 */
export class LeanLanguageServices extends Context.Service<
  LeanLanguageServices,
  LeanLanguageServicesShape
>()('@texra-ai/texra/tools/LeanLanguageServices') {}
