/**
 * The process's Effect runtime (PRD one-fold-three-renderers, 7.7): one
 * `ManagedRuntime` per process, made at the composition root beside
 * `initPlatform()` and disposed on the existing shutdown path. `runPromise`,
 * `runFork`, and `runSync` appear at the entries and at the outermost
 * Promise-facing methods; inside, cancellation is fiber interruption.
 * Installed like the process roots: exactly once, by the entry.
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
import type { Secrets } from './secrets';

/**
 * The runtime over the process-lifetime services every entry provides: the
 * cohort-A tags beside the records, the account plane, the resume port, the
 * language-model bridge, the Lean port and the HTTP client, merged once in
 * `installProcessRuntime`'s `services` layer, plus the standard library's
 * `FileSystem` and `Path`, which the same install provides from
 * `@effect/platform-node` so a program that reads or resolves a file takes
 * them from context instead of building a Node layer of its own.
 */
export type ProcessServices =
  | FileSystem.FileSystem
  | Path.Path
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

let processRuntime: ProcessRuntime | null = null;

/** Install the process runtime. Called by a composition root exactly once at
 *  startup, right beside `initPlatform()`. */
export function initProcessRuntime(instance: ProcessRuntime): void {
  processRuntime = instance;
}

/**
 * The installed runtime, or `null` — the non-throwing read, like
 * `tryPlatform()` beside `platform()`. An entry that may or may not be the
 * first one, and a shutdown that may or may not be the first one, ask here
 * instead of keeping a latch of their own: a boolean beside the install
 * drifts from the fact the moment a dispose or a raced install lands between
 * the two.
 */
export function tryProcessRuntime(): ProcessRuntime | null {
  return processRuntime;
}

/**
 * Forget `instance`, but only while it is still the installed one. Called by
 * `disposeProcessRuntime` AFTER its disposal, never before: the layer
 * finalizers unwinding inside `dispose()` still publish through
 * `effectRuntime()`, and a runtime installed to replace this one while it was
 * unwinding must survive the clear that ends its predecessor.
 */
export function clearProcessRuntime(instance: ProcessRuntime): void {
  if (processRuntime === instance) processRuntime = null;
}

/** The process runtime, for the Promise-facing boundaries that run fibers. */
export function effectRuntime(): ProcessRuntime {
  if (!processRuntime) {
    throw new Error(
      'Process runtime not initialized: call initProcessRuntime() before running Effect code.',
    );
  }
  return processRuntime;
}

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
