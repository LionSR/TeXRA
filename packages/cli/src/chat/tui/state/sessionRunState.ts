import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { isActivePhase } from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

import {
  rootRunPending,
  rootRunStartAvailable,
  rootRunStreamId,
} from './cliState';

export interface ClearableTuiSessionState {
  streamId: StreamTabId | undefined;
  /** Root conversation that remains recoverable after an interrupted turn. */
  interruptedStreamId: StreamTabId | undefined;
  executionId: string | undefined;
  runtimeHost?: AgentRuntimeHost;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

export type TuiSession = ClearableTuiSessionState;

type InterruptibleTuiSessionState = Pick<
  ClearableTuiSessionState,
  'streamId' | 'runPromise' | 'runCompleted'
>;

type PendingTuiRunSessionState = Pick<
  ClearableTuiSessionState,
  'runPromise' | 'runCompleted'
>;

type PublishedTuiRunSessionState = Pick<
  ClearableTuiSessionState,
  'runPromise' | 'runCompleted' | 'streamId'
>;

export function clearTuiSessionRunState(
  session: ClearableTuiSessionState,
): void {
  session.streamId = undefined;
  session.interruptedStreamId = undefined;
  session.executionId = undefined;
  session.runtimeHost = undefined;
  session.runPromise = undefined;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
  publishChatTuiRunState(session);
}

export function markChatTuiRunPending(
  session: ClearableTuiSessionState,
  runPromise: Promise<void>,
  runtimeHost?: AgentRuntimeHost,
): void {
  session.streamId = undefined;
  session.runtimeHost = runtimeHost;
  session.runPromise = runPromise;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
  publishChatTuiRunState(session);
}

export function markChatTuiRunCompleted(
  session: PublishedTuiRunSessionState,
): void {
  session.runCompleted = true;
  publishChatTuiRunState(session);
}

/**
 * Atomically check-and-claim the root-run slot: fuses
 * {@link chatTuiCanStartRootRun} and {@link markChatTuiRunPending} into one
 * synchronous call so no caller can observe — or race on — a window between
 * the check and the claim. Every root-run entry point that awaits *before*
 * it would otherwise claim (resume, follow-up-wake resume) MUST call this as
 * its first statement, before any `await`, so the claim happens before the
 * caller can be suspended and a concurrent entry point can slip in and claim
 * the same slot. `startRootRun` claims via `markChatTuiRunPending` directly
 * instead — it never suspends before claiming, so it has no check-then-await
 * window for this primitive to close.
 */
export function tryClaimRootRunSlot(
  session: ClearableTuiSessionState,
  runPromise: Promise<void>,
  runtimeHost?: AgentRuntimeHost,
): boolean {
  if (!chatTuiCanStartRootRun(session)) return false;
  markChatTuiRunPending(session, runPromise, runtimeHost);
  return true;
}

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

export function chatTuiCanStartRootRun(
  session: PendingTuiRunSessionState,
): boolean {
  return !session.runPromise || session.runCompleted;
}

/**
 * Single publisher of the session run-state facts into cliState signals.
 * Every mutation of `runPromise`/`runCompleted`/`streamId` must flow through
 * a caller of this function — renders read only the published signals, so an
 * unpublished mutation would leave the Ctrl-C hint stale (#8273).
 */
export function publishChatTuiRunState(
  session: PublishedTuiRunSessionState,
): void {
  const canStart = chatTuiCanStartRootRun(session);
  rootRunStartAvailable.set(canStart);
  rootRunPending.set(!canStart);
  rootRunStreamId.set(session.streamId);
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
