import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';

import {
  rootRunPending,
  rootRunStartAvailable,
  rootRunStreamId,
} from './cliState';

/**
 * Root-run state of one chat TUI session.
 *
 * The run-claim triple (`streamId`, `runPromise`, `runCompleted`) is mirrored
 * into the `rootRun*` signals that renders read, and the mirror must never lag
 * the fields: an unpublished mutation leaves the Ctrl-C hint and the
 * start-availability gate stale (#8273). The triple is therefore owned here —
 * private storage, published by construction — instead of being a plain record
 * that every writer had to remember to publish afterwards. `streamId` accepts
 * a direct write because it moves alone; the multi-field transitions are
 * methods so each publishes once, at its end, rather than through a
 * half-applied intermediate state.
 *
 * The remaining fields carry no signal mirror and stay plain.
 */
export class TuiSession {
  private _streamId: StreamTabId | undefined;
  private _runPromise: Promise<void> | undefined;
  private _runCompleted = false;

  /** Root conversation that remains recoverable after an interrupted turn. */
  interruptedStreamId: StreamTabId | undefined;
  executionId: string | undefined;
  presentationHost?: CliRuntimeHost;
  runExitCode: CliExitCode = CliExitCode.Success;
  stopRequested = false;

  get streamId(): StreamTabId | undefined {
    return this._streamId;
  }

  set streamId(streamId: StreamTabId | undefined) {
    this._streamId = streamId;
    this.publish();
  }

  get runPromise(): Promise<void> | undefined {
    return this._runPromise;
  }

  get runCompleted(): boolean {
    return this._runCompleted;
  }

  clearRunState(): void {
    this._streamId = undefined;
    this._runPromise = undefined;
    this._runCompleted = false;
    this.interruptedStreamId = undefined;
    this.executionId = undefined;
    this.presentationHost = undefined;
    this.runExitCode = CliExitCode.Success;
    this.stopRequested = false;
    this.publish();
  }

  markRunPending(
    runPromise: Promise<void>,
    presentationHost?: CliRuntimeHost,
  ): void {
    this._streamId = undefined;
    this._runPromise = runPromise;
    this._runCompleted = false;
    this.presentationHost = presentationHost;
    this.runExitCode = CliExitCode.Success;
    this.stopRequested = false;
    this.publish();
  }

  markRunCompleted(): void {
    this._runCompleted = true;
    this.publish();
  }

  /**
   * Atomically check-and-claim the root-run slot: fuses
   * {@link chatTuiCanStartRootRun} and {@link markRunPending} into one
   * synchronous call so no caller can observe — or race on — a window between
   * the check and the claim. Every root-run entry point that awaits *before*
   * it would otherwise claim (resume, follow-up-wake resume) MUST call this as
   * its first statement, before any `await`, so the claim happens before the
   * caller can be suspended and a concurrent entry point can slip in and claim
   * the same slot. `startRootRun` claims via `markRunPending` directly
   * instead — it never suspends before claiming, so it has no check-then-await
   * window for this primitive to close.
   */
  tryClaimRootRunSlot(
    runPromise: Promise<void>,
    presentationHost?: CliRuntimeHost,
  ): boolean {
    if (!chatTuiCanStartRootRun(this)) return false;
    this.markRunPending(runPromise, presentationHost);
    return true;
  }

  /**
   * Mirror the run-claim triple into the cliState signals. Renders read only
   * the published signals, so this is the sole bridge between the two.
   */
  private publish(): void {
    const runPending = chatTuiRunPending(this);
    rootRunStartAvailable.set(!runPending);
    rootRunPending.set(runPending);
    rootRunStreamId.set(this._streamId);
  }
}

type InterruptibleTuiSessionState = Pick<
  TuiSession,
  'streamId' | 'runPromise' | 'runCompleted'
>;

type PendingTuiRunSessionState = Pick<
  TuiSession,
  'runPromise' | 'runCompleted'
>;

export function chatTuiCanInterruptActiveRun(
  session: InterruptibleTuiSessionState,
): boolean {
  return Boolean(
    session.streamId && session.runPromise && !session.runCompleted,
  );
}

/**
 * Run facts the stop predicates consume. Two producers share this shape:
 * `runChatTui` derives it from the mutable session (signal-handler paths),
 * and the StatusBar derives it from the `rootRunPending`/`rootRunStreamId`
 * signals so the Ctrl-C hint recomputes reactively during renders.
 */
export interface ChatTuiRunStopFacts {
  readonly runPending: boolean;
  readonly streamId: StreamTabId | undefined;
  readonly status: StreamPhase | undefined;
}

export function chatTuiCanStopActiveRun(facts: ChatTuiRunStopFacts): boolean {
  if (!facts.runPending) return false;
  if (!facts.streamId) return true;
  return facts.status === undefined || isActivePhase(facts.status);
}

export function chatTuiCanStopVisibleRun(facts: ChatTuiRunStopFacts): boolean {
  return (
    chatTuiCanStopActiveRun(facts) ||
    Boolean(facts.streamId && isActivePhase(facts.status))
  );
}

/** Whether the session still holds an unfinished root-run claim. Sole
 *  derivation of that fact: the availability predicate, the published
 *  `rootRunPending` signal, and every caller-side "a run is in flight" check
 *  read it here instead of re-deriving `runPromise && !runCompleted`. */
export function chatTuiRunPending(session: PendingTuiRunSessionState): boolean {
  return Boolean(session.runPromise) && !session.runCompleted;
}

export function chatTuiCanStartRootRun(
  session: PendingTuiRunSessionState,
): boolean {
  return !chatTuiRunPending(session);
}

export function chatTuiCanSelectModel(input: {
  readonly canStartRootRun: boolean;
  readonly streamId: StreamTabId | undefined;
  readonly status: StreamPhase | undefined;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canStartRootRun ||
    Boolean(
      input.streamId &&
      input.status === STREAM_PHASE.WAITING &&
      input.hasActiveToolUseFlow,
    )
  );
}

export type ChatTuiSigintAction =
  'clean-exit' | 'force-exit' | 'preserve-exit' | 'interrupt-and-arm-exit';

export function chatTuiSigintAction(input: {
  readonly exitArmed: boolean;
  readonly canStopActiveRun: boolean;
  readonly resumableIdle: boolean;
}): ChatTuiSigintAction {
  if (input.exitArmed) return 'force-exit';
  if (input.canStopActiveRun) return 'interrupt-and-arm-exit';
  if (input.resumableIdle) return 'preserve-exit';
  return 'clean-exit';
}

/**
 * On exit, a tool-use session suspended at the WAIT node (idle/WAITING) with a
 * live flow must NOT be interrupted: interrupting clears its per-execution flow
 * record in `runToolUseFlow`'s finally, destroying the only resumable state.
 */
export function chatTuiIsResumableIdleOnExit(input: {
  readonly canInterruptActiveRun: boolean;
  readonly canStopActiveRun: boolean;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canInterruptActiveRun &&
    !input.canStopActiveRun &&
    input.hasActiveToolUseFlow
  );
}
