/**
 * The process's Effect runtime (PRD one-fold-three-renderers, 7.7): one
 * `ManagedRuntime` per process, made at the composition root beside
 * `initPlatform()` and disposed on the existing shutdown path. `runPromise`,
 * `runFork`, and `runSync` appear at the entries and at the outermost
 * Promise-facing methods; inside, cancellation is fiber interruption.
 *
 * Held by the entry that made it, never by this module: each composition
 * root keeps its `ManagedRuntime` in a local and threads it to the surfaces
 * that run on it (rulings ledger, #12720). This module owns the types that
 * describe it and the fork-failure reporting wrapper the roots build it
 * with; there is no ambient slot to read it back from.
 */
import {
  Cause,
  Effect,
  Exit,
  type FileSystem,
  type ManagedRuntime,
  type Path,
} from 'effect';
import type { ToolInjections } from '@agent/runtime/toolInjection';
import type { SupabaseAuth } from '@auth/SupabaseAuth';
import type { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import type { InquiryRecords } from '@shared/session/inquiryRecords';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import type { SetupPlatform } from '@tools/setup/platform';
import type { HttpClient } from 'effect/unstable/http';

import type { AgentResume, AppState } from './interfaces';
import type { LanguageModel } from './languageModel';
import type { GlobalStorageFs } from './rootedFs';
import type { Secrets } from './secrets';

/**
 * The runtime over the process-lifetime services every entry provides: the
 * cohort-A tags beside the records, the account plane, the resume port, the
 * language-model bridge, the Lean port and the HTTP client, merged once in
 * `installProcessRuntime`'s `services` layer, plus the standard library's
 * `FileSystem` and `Path`, which the same install provides from
 * `@effect/platform-node` so a program that reads or resolves a file takes
 * them from context instead of building a Node layer of its own, and
 * `GlobalStorageFs`, the cross-workspace storage view every session of the
 * process shares.
 */
export type ProcessServices =
  | FileSystem.FileSystem
  | Path.Path
  | GlobalStorageFs
  | HttpClient.HttpClient
  | InquiryRecords
  | UpdateCheckRecords
  | Secrets
  | AppState
  | LanguageModel
  | AgentResume
  | SetupPlatform
  | ToolInjections
  | LeanLanguageServices
  | SupabaseAuth;

export type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices,
  never
>;

/**
 * A runtime whose `runFork` reports a fiber's failure or defect on exit
 * (#12613). `Fiber.addObserver` fires on every exit, including fibers a
 * caller later `Fiber.join`s, so a joined failure is logged here and still
 * delivered to the joiner. A success or an interrupts-only exit stays silent.
 * `runPromise` and `runSync` hand their exits to the caller already.
 */
export function withForkFailureReporting<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
): ManagedRuntime.ManagedRuntime<R, ER> {
  // The report forks on the underlying `runFork`, not the observed one: a
  // defect in the reporter itself must not recurse back into this observer.
  const reportExit = (
    fiberId: number,
    exit: Exit.Exit<unknown, unknown>,
  ): void => {
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
    runtime.runFork(
      Effect.logError('Unhandled failure in forked fiber', exit.cause).pipe(
        Effect.annotateLogs({ forkedFiber: fiberId }),
      ),
    );
  };
  return {
    ...runtime,
    runFork: (effect, options) => {
      const fiber = runtime.runFork(effect, options);
      fiber.addObserver((exit) => reportExit(fiber.id, exit));
      return fiber;
    },
  };
}
